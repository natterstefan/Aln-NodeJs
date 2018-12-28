/*
Copyright (C) 2018 Dean151 a.k.a. Thomas Durand

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
*/

"use strict";

const http = require('http');
const express = require('express');
const helmet = require('helmet');
const bodyParser = require('body-parser');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const bcrypt = require('bcrypt');

const Quantity = require("./models/quantity");
const Meal = require("./models/meal");
const Planning = require("./models/planning");

class Server {

  /**
   * @param {{local_port: number, session_name: string, session_secret: string, mysql_host: string, mysql_user: string, mysql_password: string, mysql_database: string}} config
   * @param {FeederCoordinator} feederCoordinator
   * @param {DataBaseCoordinator} database
   */
  constructor(config, feederCoordinator, database) {

    // Create a service (the app object is just a callback).
    let app = express();

    // Use helmet for better security & obfuscation settings
    app.use(helmet());

    // And the session mechanism
    app.use(session({
      key: config.session_name,
      secret: config.session_secret,
      store: new MySQLStore({
        host: config.mysql_host,
        user: config.mysql_user,
        password: config.mysql_password,
        database: config.mysql_database
      }),
      resave: false,
      saveUninitialized: false,
      cookie: { secure: 'auto' }
    }));

    // Create the routes for the API
    let api = Server.createApiRouter(feederCoordinator, database);

    // Use the routes
    app.use('/api', api);

    http.createServer(app).listen(config.local_port, 'localhost');
  }

  /**
   * @param {FeederCoordinator} feederCoordinator
   * @param {DataBaseCoordinator} database
   * @return {express.Router}
   */
  static createApiRouter(feederCoordinator, database) {
    let api = express.Router();

    api.use(bodyParser.urlencoded({ extended: true }));
    api.use(bodyParser.json());

    api.use((err, req, res, next) => {
      res.status(500);
      res.json({ success: false, error: err.toString() });
    });

    /** AUTHENTICATION MECHANISMS **/

    api.post('/user/login', Server.requiresNotLoggedIn, (req, res, next) => {
      if (!req.body.email || !req.body.password) {
        throw 'Missing email or password';
      }
      database.getUser(req.body.email, (user) => {
        if (typeof user === 'undefined') {
          res.status(401);
          res.json({ success: false, error: 'Wrong email/password' });
        } else {
          // FIXME: bcrypt is less safe than scrypt.
          bcrypt.compare(req.body.password, user.password, (err, res) => {
            if (!res) {
              res.status(401);
              res.json({ success: false, error: 'Wrong email/password' });
            } else {
              req.session.user = user.jsoned();
              res.json({ success: true, user: req.session.user });
            }
          });
        }
      });
    });

    api.post('/user/register', Server.requiresNotLoggedIn, (req, res, next) => {
      if (!req.body.email || !req.body.password) {
        throw 'Missing email or password';
      }

      // Check if the user already exists
      database.getUser(req.body.email, (user) => {
        if (typeof user !== 'undefined') {
          res.status(401);
          res.json({ success: false, error: 'Email already in use' });
        } else {
          // TODO create user and register it

          database.getUser(req.body.email, (user) => {
            if (typeof user === 'undefined') {
              res.status(500);
              res.json({ success: false, error: 'Registration failed' });
            } else {
              // Auto-connexion
              req.session.user = user.jsoned();
              res.json({ success: true, user: req.session.user });
            }
          });
        }
      });
    });

    // Logging out
    api.post('/user/logout', Server.requiresLogin, (req, res, next) => {
      // delete session object
      req.session.destroy(function(err) {
        if(err) {
          throw err;
        }
        res.json({ success: true });
      });
    });


    /** FEEDER HANDLING **/

    api.route('/feeder/status').post(Server.requiresLogin, Server.checkFeederAssociation, (req, res) => {
      let feeders = feederCoordinator.getFeeder(req.body.identifier);
      res.json(feeders);
    });

    api.route('/feeder/feed').put(Server.requiresLogin, Server.checkFeederAssociation, (req, res) => {
      let quantity = new Quantity(req.body.quantity);
      feederCoordinator.feedNow(req.body.identifier, quantity, (msg) => {
        if (msg !== 'success') {
          throw msg;
        }
        res.json({ success: true });
      });
    });

    api.route('/feeder/quantity').put(Server.requiresLogin, Server.checkFeederAssociation, (req, res) => {
      let quantity = new Quantity(req.body.quantity);
      feederCoordinator.setDefaultQuantity(req.body.identifier, quantity, (msg) => {
        if (msg !== 'success') {
          throw msg;
        }
        res.json({ success: true });
      });
    });

    api.route('/feeder/planning')
      .post(Server.requiresLogin, Server.checkFeederAssociation, (req, res) => {
        // Fetch the planning if it's exists
        database.getCurrentPlanning(req.body.identifier, (planning) => {
          if (typeof planning === 'undefined') {
            res.status(500);
            res.json({ success: false, error: 'No planning' });
          }
          res.json({ success: true, meals: planning.jsoned() });
        });
      })
      .put(Server.requiresLogin, Server.checkFeederAssociation, (req, res) => {
        let meals = req.body.meals.map((obj) => { return new Meal(obj.time, obj.quantity, obj.enabled); });
        let planning = new Planning(meals);
        feederCoordinator.setPlanning(req.body.identifier, planning, (msg) => {
          if (msg !== 'success') {
            throw msg;
          }
          res.json({ success: true });
        });
      });

    return api;
  }

  static requiresNotLoggedIn (req, res, next) {
    if (req.session && req.session.user) {
      res.status(401);
      res.json({ success: false, error: 'Already logged-in as ' + req.session.user.email });
    } else {
      next();
    }
  }

  static requiresLogin (req, res, next) {
    if (!req.session || !req.session.user) {
      res.status(403);
      res.json({ success: false, error: 'Not logged-in' });
    } else {
      next();
    }
  }

  static checkFeederAssociation (req, res, next) {
    if (typeof req.body.identifier === 'undefined') {
      res.status(500);
      res.json({ success: false, error: 'No feeder identifier given' });
    } else {
      // TODO: check feeder <-> user association
      next();
    }
  }
}

module.exports = Server;
