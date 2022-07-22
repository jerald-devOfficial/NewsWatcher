// A Node.js Module for session login and logout
'use strict'
const bcrypt = require('bcryptjs') // for password hash comparing
const jwt = require('jwt-simple') // For token authentication
const joi = require('joi') // for data validation
const authHelper = require('./authHelper')
const express = require('express')
const router = express.Router()

// Create a security token for login and use on subsequent calls

