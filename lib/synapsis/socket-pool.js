'use strict';

var EventEmitter = require('events').EventEmitter;
var debug              = require('debug')('gc:network');
var securesocketrouter = require('./secure-socket-router.js');
var cs                 = require('./crypto-service.js');

var SocketPool = function() {
  this._socket_pool = {};
};

SocketPool.prototype.__proto__ = EventEmitter.prototype;

/**
 * Add Socket to Socket Pool
 * 1/ Exchange diffie hellman keys
 * 2/ Send password
 * 3/ Send Identity
 *
 * @param {Object} socket net socket
 * @param {Object} local_identity Local node identity (via .getLocalIdentity())
 * @return Promise
 */
SocketPool.prototype.add = function(opts) {
  let that = this;
  let socket = opts.socket;
  let password = opts.password;
  let local_identity = opts.local_identity;
  let peer = securesocketrouter(socket);

  socket.on('error', (err) => {
    if (this._socket_pool[peer.id] && this._socket_pool[peer.id].identity)
      debug('peer %s errored', this._socket_pool[peer.id].identity.name);
    socket.destroy();
    //this.emit('error', err);
    delete this._socket_pool[peer.id];
  });

  socket.on('close', () => {
    if (this._socket_pool[peer.id] && this._socket_pool[peer.id].identity) {
      debug('peer %s left', this._socket_pool[peer.id].identity.name);
      this.emit('disconnected', this._socket_pool[peer.id].identity);
    }

    socket.destroy();
    delete this._socket_pool[peer.id];
  });

  return new Promise((resolve, reject) => {
    /**
     * Exchange Diffie Hellman Keys for data ciphering
     */
    var dhObj;
    var cipher_key;

    if (socket._server) {
      peer.on('key:exchange', function(data) {
        dhObj         = cs.diffieHellman(data.prime);
        var publicKey = dhObj.publicKey;

        cipher_key  = dhObj.computeSecret(data.key);

        // @todo: handle error
        peer.send('key:final', {
          key : publicKey
        });

        return resolve({server: true, key : cipher_key});
      });
    }
    else {
      dhObj       = cs.diffieHellman();

      peer.send('key:exchange', {
        prime : dhObj.prime,
        key   : dhObj.publicKey
      });

      peer.on('key:final', function(data) {
        cipher_key = dhObj.computeSecret(data.key);
        // @todo: handle error
        return resolve({server: false, key : cipher_key});
      });
    }
  }).then(meta => {
    peer.setSecretKey(meta.key);
    //debug('status=connection secured');
    return Promise.resolve(meta);
  }).then(meta => {
    if (!password)
      return Promise.resolve(meta);

    return new Promise((resolve, reject) => {
      if (meta.server) {
        var loggingTimeout = setTimeout(() => {
          reject(new Error('Peer timeout while waiting for auth'));
        }, 2000);

        peer.on('auth', function(data) {
          clearTimeout(loggingTimeout);
          if (data.password === password) {
            debug('status=authenticated');
            peer.send('auth:status', {
              success : true
            });
            return resolve(meta);
          }
          return reject(new Error('Peer tried to connect with wrong pass'));
        });
        return false;
      }

      var sendAgain = setInterval(() => {
        peer.send('auth', {
          password : password
        });
      }, 500);

      peer.on('auth:status', data => {
        clearInterval(sendAgain);

        if (data.success === true) {
          debug('status=authenticated');
          return resolve(meta);
        }
        return reject(new Error('Authentication failed (wrong pass)'));
      });
    });
  }).then(meta => {
    /**
     * Send local identity to remote peer
     * @param {Object}  meta
     * @param {Boolean} meta.server determine if the connection is server like
     * @param {String}  meta.key    unique secret key to exchange data with peer
     */
    return new Promise((resolve, reject) => {
      peer.on('identity', function(data) {
        debug('status=identity meta info from=%s[%s]',
              data.name,
              data.public_ip);
        peer.identity = data;
        that._socket_pool[peer.id] = peer;

        if (meta && meta.server == true)
          peer.send('identity', local_identity);

        return resolve(peer);
      });

      if (meta.server == false)
        peer.send('identity', local_identity);

      // Connection timeout
      setTimeout(() => {
        reject(new Error('Connection timed out when exchanging identity'));
      }, 3000);
    });

  });
};

SocketPool.prototype.close = function() {
  var that = this;

  debug('Closing all connections');

  Object.keys(this._socket_pool).forEach(function(id) {
    that._socket_pool[id].stream.end();
  });
};

SocketPool.prototype.getAll = function() {
  var ret = [];
  var that = this;

  Object.keys(this._socket_pool).forEach(function(key) {
    ret.push(that._socket_pool[key]);
  });

  return ret;
};

SocketPool.prototype.sendToId = function(id, route, data, cb) {
  if (data)
    return this._socket_pool[id].send(route, data, (err, data) => {
      return cb(err, data, this._socket_pool[id].identity);
    });

  return this._socket_pool[id].send(route, (err, data) => {
    return cb(err, data, this._socket_pool[id].identity);
  });
};

SocketPool.prototype.broadcast = function(route, data, cb) {
  if (!cb) cb = function() {};

  this.getAll().forEach((router) => {
    if (data)
      return router.send(route, data, function(err, data) {
        cb(err, data, router.identity);
      });

    router.send(route, function(err, data) {
      return cb(err, data, router.identity);
    });
  });
};


module.exports = SocketPool;
