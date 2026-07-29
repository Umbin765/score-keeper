'use strict';

const { Store } = require('express-session');
const { getDb } = require('./db');

// SQLite-backed session store so logins survive server restarts, not just
// page refreshes. Uses the same scorekeeper.db file as everything else.
class SqliteSessionStore extends Store {
  constructor() {
    super();
    this.db = getDb();
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  }

  get(sid, cb) {
    try {
      const row = this.db.prepare('SELECT sess, expires FROM sessions WHERE sid=?').get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      const expires = sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 24 * 60 * 60 * 1000;
      this.db.prepare(`
        INSERT INTO sessions(sid, sess, expires) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expires=excluded.expires
      `).run(sid, JSON.stringify(sess), expires);
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid=?').run(sid);
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }
}

module.exports = SqliteSessionStore;
