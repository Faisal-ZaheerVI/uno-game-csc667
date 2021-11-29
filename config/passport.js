const db = require('../db');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcrypt');

// function initialize(passport) {
//     passport.use(new LocalStrategy(async (username, password, cb) => {
//         await db.any('SELECT * FROM users WHERE username=$1', [username], (err, result) => {
//           if(err) {
//             return cb(err);
//           }
      
//           if(result.rows.length > 0) {
//             const first = result.rows[0]
//             bcrypt.compare(password, first.password, function(err, res) {
//               if(res) {
//                 cb(null, { id: first.id, username: first.username});
//                } else {
//                 cb(null, false);
//                }
//             });
//            } else {
//              cb(null, false);
//            }
//         });
//     }));

//     passport.serializeUser((user, done) => {
//         done(null, user.id);
//     });
      
//     passport.deserializeUser(async (id, cb) => {
//         await db.any('SELECT * FROM users WHERE id = $1', [parseInt(id, 10)], (err, results) => {
//           if(err) {
//             return cb(err);
//           }
//           cb(null, results.rows[0]);
//         });
//     });
// }

// module.exports = initialize;

module.exports = function(passport) {
  passport.use(
    new LocalStrategy({usernameField: 'username', passwordField: 'password'}, (username, password, done) => {
      // Match user
      db.any('SELECT * FROM users WHERE username = $1', username)
      .then( result => {
        // If no username exists
        if(result.length < 1) {
          // errors.push({message: "Username does not exist."});
          // res.render('registration', { errors })
          return done('That user was not found.', false);
        } else {
          // Username exists
          return done(null, {id: result[0].id, })
        }
      })
    })
  )
};

passport.serializeUser((user, done) => {
    done(null, user.id);
});
  
passport.deserializeUser((id, done) => {
  db.one('SELECT * FROM users WHERE id=$1', [id])
  .then(({ id, username }) => done(null, { id, username }))
  .catch( error => {
    console.log( error );
    res.json({ error });
  });
});
