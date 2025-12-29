const nodemailer = require('nodemailer'); //

// 1. Create the transporter using Railway Variables
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true, // Port 465 requires secure: true
  auth: {
    user: process.env.SMTP_USER, // Pulled from Railway Variables
    pass: process.env.SMTP_PASS  // Pulled from Railway Variables
  }
});

// 2. Set up the email content
const mailOptions = {
  from: process.env.SMTP_USER, 
  to: 'YOUR_PERSONAL_EMAIL@gmail.com', // <-- CHANGE THIS to your real email
  subject: 'SLGP MESH Authentication Test',
  text: 'Success! Your Railway app is now authenticated using secure variables.'
};

// 3. Send the email
transporter.sendMail(mailOptions, (error, info) => {
  if (error) {
    return console.log('Error occurred:', error); //
  }
  console.log('Email sent successfully!'); //
  console.log('Server Response:', info.response); //
});