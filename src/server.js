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
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const helmet = require('helmet');
const bodyParser = require('body-parser');

const validator = require('validator');

const CryptoHelper = require('./crypto-helper');
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

    let requiresNotLoggedIn = (req, res, next) => {
      if (req.session && req.session.user) {
        res.status(401);
        res.json({ success: false, error: 'Already logged-in as ' + req.session.user.email });
      } else {
        next();
      }
    };

    /** AUTHENTICATION MECHANISMS **/

    api.post('/user/register', requiresNotLoggedIn, (req, res, next) => {
      if (!req.body.email) {
        throw 'Missing email';
      }

      if (!validator.isEmail(req.body.email)) {
        res.status(401);
        res.json({ success: false, error: 'Not an email' });
        return;
      }

      // Check if the user already exists
      let email = validator.normalizeEmail(req.body.email);
      database.getUserByEmail(email, (user) => {
        if (typeof user !== 'undefined') {
          res.status(401);
          res.json({ success: false, error: 'Email already in use' });
          return;
        }

        database.createUser({
          email: email,
          hash: 'not-an-hash',
        }, (success) => {
          if (!success) {
            res.status((500));
            res.json({ success: false, error: 'Registration failed' });
            return;
          }

          database.getUserByEmail(email, (user) => {
            if (typeof user === 'undefined') {
              res.status((500));
              res.json({ success: false, error: 'Registration failed' });
              return;
            }

            user.sendResetPassMail(true);
            res.json({ success: true });
          });
        });
      });
    });

    api.post('/user/login', requiresNotLoggedIn, (req, res, next) => {
      if (!req.body.email || !req.body.password) {
        throw 'Missing email or password';
      }
      let email = validator.normalizeEmail(req.body.email);
      database.getUserByEmail(email, (user) => {
        if (typeof user === 'undefined') {
          res.status(401);
          res.json({ success: false, error: 'Wrong email/password' });
          return;
        }

        CryptoHelper.comparePassword(req.body.password, user.password, (err, success) => {
          if (!success) {
            res.status(401);
            res.json({ success: false, error: 'Wrong email/password' });
            return;
          }

          database.loggedUser(user.id);
          req.session.user = user.jsoned();
          res.json({ success: true, user: req.session.user });
        });
      });
    });

    api.post('/user/request_new_password', requiresNotLoggedIn, (req, res, next) => {
      if (!req.body.email) {
        throw 'Missing email or password';
      }
      let email = validator.normalizeEmail(req.body.email);
      database.getUserByEmail(email, (user) => {
        if (typeof user !== 'undefined') {
          user.sendResetPassMail(false);
        }
        res.json({ success: true });
      });
    });

    api.post('/user/password_reset', requiresNotLoggedIn, (req, res, next) => {
      if (!req.body.user_id || !req.body.timestamp || !req.body.token) {
        throw 'Missing parameter';
      }

      database.getUserById(req.body.user_id, (user) => {
        if (typeof user === 'undefined') {
          res.status(403);
          res.json({ success: false, error: 'Wrong parameter' });
          return;
        }
        
        // First login does not expires. Other expires after 24 hours
        if (user.login > 0 && req.body.timestamp > Math.round(new Date().getTime()/1000) - 24*3600) {
          res.status(403);
          res.json({ success: false, error: 'Wrong parameter' });
          return;
        }

        if (!CryptoHelper.checkBase64Hash([req.body.timestamp, user.login, user.id, user.password].join(':'))) {
          res.status(403);
          res.json({ success: false, error: 'Wrong parameter' });
          return;
        }

        let passwordToken = CryptoHelper.randomKeyBase64(64);
        req.session.passworkToken = passwordToken;

        database.loggedUser(user.id);
        req.session.user = user.jsoned();
        res.json({ success: true, user: req.session.user, token: passwordToken });
      });
    });

    // Every endpoint below requires login-in
    api.use((req, res, next) => {
      if (!req.session || !req.session.user) {
        res.status(403);
        res.json({ success: false, error: 'Not logged-in' });
      } else {
        next();
      }
    });

    api.put('/user/edit', (req, res, next) => {
      // TODO: profile edition (email / password change)
      // email/password change will need current password
      // password may be changed with password change token
      /*
        CryptoHelper.hashPassword(req.body.password, (err, hash) => {
          if (err) {
            res.status((500));
            res.json({ success: false, error: err.toString() });
            return;
          }
        });
       */
    });

    // Logging out
    api.post('/user/logout', (req, res, next) => {
      // delete session object
      req.session.destroy(function(err) {
        if(err) {
          throw err;
        }
        res.json({ success: true });
      });
    });


    /** FEEDER HANDLING **/

    api.route('/feeder/claim')
      .post((req, res, next) => {
        if (typeof req.body.identifier === 'undefined') {
          res.status(500);
          res.json({ success: false, error: 'No feeder identifier given' });
          return;
        }

        let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        if (!validator.isIP(ip)) {
          res.status(401);
          res.json({ success: false, error: 'Feeder not found' });
          return;
        }

        database.claimFeeder(req.body.identifier, req.session.user.id, ip, (success) => {
          if (!success) {
            res.status(401);
            res.json({ success: false, error: 'Feeder not found' });
          } else {
            res.json({ success: true });
          }
        });
      });

    // We now need to check feeder association
    api.use((req, res, next) => {
      if (typeof req.body.identifier === 'undefined') {
        res.status(500);
        res.json({ success: false, error: 'No feeder identifier given' });
        return;
      }

      database.checkFeederAssociation(req.body.identifier, req.session.user.id, (allowed) => {
        if (!allowed) {
          res.status(403);
          res.json({ success: false, error: 'Feeder not found' });
          return;
        }
        
        next();
      });
    });

    api.route('/feeder/status').post((req, res) => {
      let feeders = feederCoordinator.getFeeder(req.body.identifier);
      res.json(feeders);
    });

    api.route('/feeder/feed').put((req, res) => {
      let quantity = new Quantity(req.body.quantity);
      feederCoordinator.feedNow(req.body.identifier, quantity, (msg) => {
        if (msg !== 'success') {
          throw msg;
        }
        res.json({ success: true });
      });
    });

    api.route('/feeder/quantity').put((req, res) => {
      let quantity = new Quantity(req.body.quantity);
      feederCoordinator.setDefaultQuantity(req.body.identifier, quantity, (msg) => {
        if (msg !== 'success') {
          throw msg;
        }
        res.json({ success: true });
      });
    });

    api.route('/feeder/planning')
      .post((req, res) => {
        // Fetch the planning if it's exists
        database.getCurrentPlanning(req.body.identifier, (planning) => {
          if (typeof planning === 'undefined') {
            res.status(500);
            res.json({ success: false, error: 'No planning' });
          }
          res.json({ success: true, meals: planning.jsoned() });
        });
      })
      .put((req, res) => {
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
}

module.exports = Server;
