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

const CryptoHelper = require('../crypto-helper');

class User {

  /**
   * @param {{id: number, email: string, email_shown: string, email_unvalidated: string|null, password: string, register: string, login: string, feeders: string|null}} row
   */
  constructor (row) {
    this.id = row.id;
    this.email = row.email;
    this.shown_email = row.email_shown;
    this.unvalidated_email = row.email_unvalidated;
    this.password = row.password;
    this.register = row.register;
    this.login = row.login;

    if (row.feeders) {
      this.feeders = row.feeders.split(',').reduce(function (carry, data) {
        let components = data.split(':');
        let feeder = {
          id: +components[0],
        };
        if (components[1]) {
          feeder.name = components[1];
        }
        if (components[2]) {
          feeder.defaultAmount = components[2];
        }
        carry.push(feeder);
        return carry;
      }, []);
    }
    else {
      this.feeders = undefined;
    }
  }

  /**
   * @param {{hmac_secret: string, base_url: string}} config
   * @param {string} type
   * @param {string} key
   */
  generateUrl(config, type, key) {
    let timestamp = Math.round(new Date().getTime()/1000);
    let hash = CryptoHelper.hashBase64([timestamp, this.id, key].join(':'), config.hmac_secret);
    return config.base_url + '/user/' + type + '/' + this.id + '/' + timestamp + '/' + hash;
  }

  /**
   * @param {{hmac_secret: string, base_url: string}} config
   * @param {ExternalCommunicator} communicator
   * @return Promise
   */
  sendResetPassMail(config, communicator) {
    // generate token
    let type = this.login ? 'reset_password' : 'create_password';
    let url = this.generateUrl(config, type, this.login + ':' + this.password);

    let subject = type === 'reset_password' ? 'Password reset request' : 'Welcome on BetterAln!';
    let message = type === 'reset_password' ? ('To proceed with your password reset request, please follow this link:\n' + url + '\n\nIf you\'re not at the origin of this request, please ignore this email.') : ('Welcome on BetterAln!\n\nFollow this link to continue your registering: \n' + url);

    return communicator.sendMail(this.shown_email, this.shown_email, subject, message);
  }

  /**
   * @param {{hmac_secret: string}} config
   * @param {number} timestamp
   * @param {string} hash
   * @return {boolean}
   */
  validatePassMail(config, timestamp, hash) {
    // First login does not expires. Other expires after 24 hours
    if (this.login > 0 && timestamp > Math.round(new Date().getTime()/1000) - 24*3600) {
      return false;
    }

    return CryptoHelper.checkBase64Hash([timestamp, this.id, this.login, this.password].join(':'), hash, config.hmac_secret);
  }

  /**
   * @param {{hmac_secret: string, base_url: string}} config
   * @param {ExternalCommunicator} communicator
   * @return Promise
   */
  sendValidateEmailMail(config, communicator) {
    let url = this.generateUrl(config, 'validate_email', this.unvalidated_email);

    // send a mail to unvalidated_email value.
    // Also send a mail to mail value warning about the change.
    return Promise.all([
      communicator.sendMail(this.shown_email, this.shown_email, 'Email change request', 'You have requested to change your email address to ' + this.unvalidated_email + '<br>If you\'re not at the origin of this request, please contact the support team as soon as possible ; and change your password.'),
      communicator.sendMail(this.unvalidated_email, this.shown_email, 'Please validate your email', 'Please click the following link to validate this email as your main BetterAln account : \n' + url),
    ]);
  }

  /**
   * @param {{hmac_secret: string}} config
   * @param {number} timestamp
   * @param {string} hash
   * @return {boolean}
   */
  validateEmailMail(config, timestamp, hash) {
    // Validity of such mail is 24h
    if (timestamp > Math.round(new Date().getTime()/1000) - 24*3600) {
      return false;
    }

    return CryptoHelper.checkBase64Hash([timestamp, this.id, this.unvalidated_email].join(':'), hash, config.hmac_secret);
  }

  /**
   * @param {DataBaseCoordinator} database
   * @return Promise
   */
  validateUnvalidatedMail(database) {
    return new Promise((resolve, reject) => {

      if (this.unvalidated_email === undefined || this.unvalidated_email === null) {
        reject(new Error('No validating email pending'));
        return;
      }

      const validator = require('validator');
      if (!validator.isEmail(this.unvalidated_email)) {
        reject(new Error('No validating email pending'));
        return;
      }

      let newMail = validator.normalizeEmail(this.unvalidated_email);
      database.getUserByEmail(newMail).then((user) => {
        if (user) {
          reject(new Error('Email already in use'));
        }

        this.email = newMail;
        this.shown_email = this.unvalidated_email;
        this.unvalidated_email = null;
        database.updateUser(this).then(resolve, reject);
      });
    });
  }

  /**
   * @returns {{id: number, email: string}}
   */
  jsoned () {
    return {
      id: this.id,
      email: this.email,
      shown_email: this.shown_email,
      register: this.register ? this.register.toJSON() : null,
      login: this.login ? this.login.toJSON() : null,
      feeders: this.feeders,
    };
  }

}

module.exports = User;
