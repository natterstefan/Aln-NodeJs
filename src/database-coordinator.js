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

const mysql = require('mysql');

class DataBaseCoordinator {

  /**
   * @param {{mysql_host: string, mysql_user: string, mysql_password: string, mysql_database: string}} config
   */
  constructor (config) {
    this.isConnected = false;

    this.con = mysql.createConnection({
      host: config.mysql_host,
      user: config.mysql_user,
      password: config.mysql_password,
      database: config.mysql_database
    });

    this.con.connect((err) => {
      if (err) {
        console.log('Could not connect to database: ', err);
      }
      else {
        this.con.query('SHOW TABLES LIKE ?;', ['feeders'], (err, result, fields) => {
          if (result.length === 0) {
            // We create the tables, it's the first app start
            console.log('Tables does not exists. You need to run init.sql file to create them!');
          }
          else {
            this.isConnected = true;
            console.log('Database connection is ready');
          }
        });
      }
    });
  }

  /**
   * @returns {boolean}
   */
  isReady() {
    return this.isConnected;
  }

  /**
   * @param {number} id
   * @return Promise
   */
  getUserById(id) {
    return this.getUserBy('id', id);
  }

  /**
   * @param {string} email
   * @return Promise
   */
  getUserByEmail(email) {
    return this.getUserBy('email', email);
  }

  /**
   * @param {string} column 
   * @param {string|number} value
   * @return Promise
   */
  getUserBy(column, value) {
    return new Promise((resolve, reject) => {

      var query = 'SELECT u.*, GROUP_CONCAT(CONCAT(f.id, \':\', f.name, \':\', f.default_value)) as feeders FROM users u LEFT JOIN feeders f ON f.owner = u.id ';
      if (column === 'id') {
        query += 'WHERE u.id = ?';
      }
      else if (column === 'email') {
        query = 'WHERE u.email = ?';
      }
      else {
        reject(new Error('Undetermined column for getting user'));
        return;
      }
      query += ' HAVING u.id IS NOT NULL';

      this.con.query(query, [value], (err, results, fields) => {
        if (err) { throw err; }

        // Parse the meals results
        if (results.length) {
          const User = require('./models/user');
          resolve(new User(results[0]));
        } else {
          resolve(undefined);
        }
      });
    });
  }

  /**
   * @param {number} user_id
   * @return Promise
   */
  loggedUser(user_id) {
    return new Promise((resolve, reject) => {
      this.con.query('UPDATE users SET login = CURRENT_TIMESTAMP where id = ?', [user_id], (err, result, fields) => {
        if (err) {
          reject(err);
        }
        else {
          resolve();
        }
      });
    });
  }

  /**
   * @param {{email: string, hash: string}} data
   * @return Promise
   */
  createUser(data) {
    return new Promise((resolve, reject) => {
      this.con.query('INSERT INTO users (email, password) VALUES (?, ?)', [data.email, data.hash], (err, result, fields) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  /**
   * @param user
   * @return Promise
   */
  updateUser(user) {
    return new Promise((resolve, reject) => {
      this.con.query('UPDATE users SET email = ?, password = ? WHERE id = ?', [user.email, user.password, user.id], (err, result, fields) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  /**
   * @param {string} identifier
   * @param {number} user_id
   * @param {string} ip
   * @return Promise
   */
  claimFeeder(identifier, user_id, ip) {
    return new Promise((resolve, reject) => {
      this.con.query('UPDATE feeders SET owner = ? WHERE owner IS NULL AND identifier = ? AND ip LIKE ?', [user_id, identifier, '%:' + ip + ':%'], (err, result, fields) => {
        if (err) {
          reject(err);
        }
        else {
          resolve(result.affectedRows >= 1);
        }
      });
    });
  }

  /**
   * @param {number} feeder_id
   * @param {number} user_id
   * @return Promise
   */
  checkFeederAssociation(feeder_id, user_id) {
    return new Promise((resolve, reject) => {
      this.con.query('SELECT * FROM feeders WHERE owner = ? AND id = ?', [user_id, feeder_id], (err, result, fields) => {
        if (err) {
          reject(err);
        }
        else {
          resolve(result.length ? result[0] : undefined);
        }
      });
    });
  }

  /**
   * @param {string} identifier
   * @return Promise
   */
  fetchFeederLastResponded(identifier) {
    return new Promise((resolve, reject) => {
      this.con.query('SELECT last_responded FROM feeders WHERE identifier = ?', [identifier], (err, result, fields) => {
        if (err) {
          reject(err);
        }
        else {
          const Feeder = require("./models/feeder");
          resolve(result.length && result[0].last_responded ? new Feeder(identifier, new Date(result[0].last_responded)) : undefined);
        }
      });
    });
  }

  /**
   * @param {string} identifier
   * @param {string} ip
   * @return Promise
   */
  registerFeeder(identifier, ip) {
    return new Promise((resolve, reject) => {
      // We try to update the feeder registry.
      let now = new Date();
      let date = now.toJSON().slice(0, 10) + ' ' + now.toJSON().slice(11, 19);
      this.con.query('UPDATE feeders SET last_responded = ?, ip = ? WHERE identifier = ?', [date, ip, identifier], (err, result, fields) => {
        if (err) {
          reject(err);
          return;
        }

        if (result.affectedRows < 1) {
          // We insert the new row in the feeder registry.
          this.con.query('INSERT INTO feeders(identifier, last_responded, ip) VALUES (?, ?, ?)', [identifier, date, ip], (err, result, fields) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        }
        else {
          resolve();
        }
      });
    });
  }

  /**
   * @param id
   * @param name
   * @return Promise
   */
  setFeederName(id, name) {
    return new Promise((resolve, reject) => {
      this.con.query('UPDATE feeders SET name = ? WHERE id = ?', [name, id], (err, result, fields) => {
        if (err) {
          reject(err);
        }
        else {
          resolve(result.affectedRows >= 1);
        }
      });
    });
  }

  /**
   * @param {string} identifier
   * @param {Quantity} quantity
   * @throws
   */
  rememberDefaultAmount(identifier, quantity) {
    if (!this.isReady()) {
      return;
    }

    this.con.query('UPDATE feeders SET default_value = ? WHERE identifier = ?', [quantity.amount, identifier], (err, result, fields) => {
      if (err) {
        throw err;
      }
    });
  }

  /**
   * @param {string} identifier
   * @param {Quantity} quantity
   * @throws
   */
  recordMeal (identifier, quantity) {
    if (!this.isReady()) {
      return;
    }

    let now = new Date();
    let date = now.toJSON().slice(0, 10);
    let time = now.toJSON().slice(11, 19);
    this.con.query('INSERT INTO meals(feeder, date, time, quantity) VALUES ((SELECT id FROM feeders WHERE identifier = ?), ?, ?, ?)', [identifier, date, time, quantity.amount], (err, result, fields) => {
      if (err) {
        throw err;
      }
    });
  }

  /**
   * @callback DataBaseCoordinator~getPlanningCallback
   * @param {Planning} planning
   * @throws
   */

  /**
   * @param {number} id
   * @param {DataBaseCoordinator~getPlanningCallback} callback
   * @throws
   */
  getCurrentPlanning (id, callback) {
    if (!this.isReady()) {
      throw 'Database is not ready';
    }

    const Planning = require('./models/planning');
    const Meal = require('./models/meal');

    // Get current planning id
    this.con.query('SELECT time, quantity, enabled FROM meals WHERE planning = (SELECT p.id FROM plannings p WHERE p.feeder = ? ORDER BY p.date DESC LIMIT 1)', [id], (err, results, fields) => {
      if (err) { throw err; }

      // Parse the meals results
      let meals = results.map((row) => { return new Meal(row.time, row.quantity, row.enabled); });
      callback(new Planning(meals));
    });
  }


  /**
   * @param {string} identifier
   * @param {Planning} planning
   * @throws
   */
  recordPlanning (identifier, planning) {
    if (!this.isReady()) {
      return;
    }

    let connection = this.con;

    let now = new Date();
    let date = now.toJSON().slice(0, 10) + ' ' + now.toJSON().slice(11, 19);

    connection.beginTransaction((err) => {
      if (err) { throw err; }

      // We register the planning in the database
      connection.query('INSERT INTO plannings(feeder, date) VALUES ((SELECT id FROM feeders WHERE identifier = ?), ?)', [identifier, date], (err, result, fields) => {
        if (err) {
          return connection.rollback(() => {
            throw err;
          });
        }

        if (planning.mealsCount() === 0) {
          connection.commit((err) => {
            if (err) {
              return connection.rollback(() => {
                throw err;
              });
            }
          });
        }
        else {
          // We then insert all meals in the table meals
          let meals = planning.sqled(result.insertId);
          connection.query('INSERT INTO meals(planning, time, quantity, enabled) VALUES ?', [meals], (err, result, fields) => {
            if (err) {
              return this.con.rollback(() => {
                throw err;
              });
            }
            connection.commit((err) => {
              if (err) {
                return connection.rollback(() => {
                  throw err;
                });
              }
            });
          });
        }
      });
    });
  }

  /**
   * @param {string} identifier
   * @param {string} type
   * @param {*} data
   * @throws
   */
  logAlert (identifier, type, data) {
    if (!this.isReady()) {
      return;
    }

    let now = new Date();
    let date = now.toJSON().slice(0, 10) + ' ' + now.toJSON().slice(11, 19);
    let json = Buffer.from(JSON.stringify(data));

    this.con.query('INSERT INTO alerts(feeder, type, date, data) VALUES ((SELECT id FROM feeders WHERE identifier = ?), ?, ?, ?)', [identifier, type, date, json], (err, result, fields) => {
      if (err) {
        throw err;
      }
    });
  }

  /**
   * @param {string} type
   * @param {Buffer} data
   * @param {string} ip
   * @throws
   */
  logUnknownData (type, data, ip) {
    if (!this.isReady()) {
      return;
    }

    // Treating the special case of uncomplete data. This happen all the time...
    // We receive multiple times a week the data 0x9da114414c
    // We prevent logging that since it does not actually make sense.
    if (data.toString('hex').match(/^9da114414c$/)) {
      return;
    }

    let now = new Date();
    let date = now.toJSON().slice(0, 10) + ' ' + now.toJSON().slice(11, 19);

    this.con.query('INSERT INTO unknown_data(date, type, ip, data) VALUES (?, ?, ?, ?)', [date, type.substring(0, 64), ip, data], (err, result, fields) => {
      if (err) {
        throw err;
      }
    });
  }
}

module.exports = DataBaseCoordinator;
