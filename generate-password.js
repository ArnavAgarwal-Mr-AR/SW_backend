const bcrypt = require('bcrypt');

const password = 'password123'; // Replace with your desired password
bcrypt.hash(password, 10).then(hash => {
    console.log('Hashed password:', hash);
}); 