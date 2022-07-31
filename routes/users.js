const express = require('express')
const bcrypt = require('bcryptjs')
const joi = require('joi') // for data validation
const authHelper = require('./authHelper')
const ObjectId = require('mongodb').ObjectId
if (process.env.NODE_ENV !== 'production') {
    var storiesRefreshLambda = require('../Lambda/NYTStoriesRefresh');
}

const router = express.Router()
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda')

try {
    var LambdaClientInst = new LambdaClient({
        region: 'us-east-1'
    })
} catch (e) {
    console.log(e);
}

router.post('/', function postUser(req, res, next) {
    // Password must be 7 to 15 characters in length and contain at least one numeric digit and a special character
    const schema = joi.object({
        displayName: joi.string().alphanum().min(3).max(50).required(),
        email: joi.string().email().min(7).max(50).required(),
        password: joi.string().regex(/^(?=.*[0-9])(?=.*[!@#$%^&*])[a-zA-Z0-9!@#$%^&*]{7,15}$/).required()
    });
    schema.validateAsync(req.body)
        .then(value => { // eslint-disable-line no-unused-vars
            req.db.collection.findOne({ type: 'USER_TYPE', email: req.body.email }, function (err, doc) {
                if (err) {
                    err.status = 400;
                    return next(err);
                }

                if (doc) {
                    let err = new Error('Email account already registered');
                    err.status = 403;
                    return next(err);
                }

                const xferUser = {
                    type: 'USER_TYPE',
                    displayName: req.body.displayName,
                    email: req.body.email,
                    passwordHash: null,
                    date: Date.now(),
                    completed: false,
                    settings: {
                        requireWIFI: true,
                        enableAlerts: false
                    },
                    newsFilters: [{
                        name: 'Technology Companies',
                        keyWords: ['Apple', 'Microsoft', 'IBM', 'Amazon', 'Google', 'Intel'],
                        enableAlert: false,
                        alertFrequency: 0,
                        enableAutoDelete: false,
                        deleteTime: 0,
                        timeOfLastScan: 0,
                        newsStories: []
                    }],
                    savedStories: []
                };

                bcrypt.hash(req.body.password, 10, function getHash(err, hash) {
                    if (err) {
                        err.status = 400;
                        return next(err);
                    }

                    xferUser.passwordHash = hash;
                    req.db.collection.insertOne(xferUser, function createUser(err, result) {
                        if (err) {
                            err.status = 400;
                            return next(err);
                        }

                        xferUser._id = result.insertedId;
                        // Fire the Lambda to update the filtered news stories
                        if (process.env.USE_LOCAL_LAMBDA === 'TRUE') {
                            storiesRefreshLambda.handler({ params_call_type: "refreshForUserFilter_call", doc: xferUser }, {}, (error, data) => { // eslint-disable-line no-unused-vars
                                if (error) {
                                    console.log("Lambda: INVOKE ERROR!", error);
                                } else {
                                    console.log("LAMBDA INVOKE SUCCESS")
                                }
                            });
                        } else {
                            let params = {
                                FunctionName: 'NYTStoriesMgmt', /* required */
                                InvocationType: "Event", // "Event" means to invoke asyncronously. Use "RequestResponse" for syncronous calls
                                LogType: "Tail",
                                Payload: JSON.stringify({ params_call_type: "refreshForUserFilter_call", doc: xferUser })
                            };

                            const command = new InvokeCommand(params);
                            LambdaClientInst.send(command, function (error, data) { // eslint-disable-line no-unused-vars
                                if (error) {
                                    console.log("Lambda: INVOKE ERROR!", error);
                                } else {
                                    console.log("Lambda INVOKE SUCCESS");
                                }
                            });
                        }
                        res.status(201).json(xferUser);
                    });
                });
            });
        })
        .catch(error => {
            let err = new Error(`Invalid field: display name 3 to 50 alpanumeric, valid email, password 7 to 15 (one number, one special character): ${error}`);
            err.status = 400;
            return next(err);
        });
});

// Delete a User in the Collection for NewsWatcher.

router.delete('/:id', authHelper.checkAuth, function (req, res, next) {
    // Verify that the passed in id to delete is the same as that in the auth token
    if (req.params.id !== req.auth.userId) {
        let err = new Error('Invalid request for account deletion');
        err.status = 401;
        return next(err);
    }

    // MongoDB should do the work of queuing this up and retrying if there is a conflict, According to their documentation.
    // This actually requires a write lock on their part.
    req.db.collection.findOneAndDelete({ type: 'USER_TYPE', _id: ObjectId(req.auth.userId) }, function (err, result) {
        if (err) {
            console.log("+++POSSIBLE USER DELETION CONTENTION ERROR?+++ err:", err);
            err.status = 409;
            return next(err);
        } else if (result.acknowledged !== true && result.ok !== 1) {
            console.log("+++POSSIBLE USER DELETION CONTENTION ERROR?+++ result:", result);
            let err = new Error('Account deletion failure');
            err.status = 409;
            return next(err);
        }

        res.status(200).json({ msg: "User Deleted" });
    });
});

router.get('/:id', authHelper.checkAuth, function (req, res, next) {
    // Verify that the passed in id to delete is the same as that in the auth token
    if (req.params.id !== req.auth.userId) {
        let err = new Error('Invalid request for account fetch');
        err.status = 401;
        return next(err);
    }

    req.db.collection.findOne({ type: 'USER_TYPE', _id: ObjectId(req.auth.userId) }, function (err, doc) {
        if (err) {
            err.status = 400;
            return next(err);
        }

        const xferProfile = {
            email: doc.email,
            displayName: doc.displayName,
            date: doc.date,
            settings: doc.settings,
            newsFilters: doc.newsFilters,
            savedStories: doc.savedStories
        };
        res.header("Cache-Control", "no-cache, no-store, must-revalidate");
        res.header("Pragma", "no-cache");
        res.header("Expires", 0);
        res.status(200).json(xferProfile);
    });
});

router.post('/:id/savedstories', authHelper.checkAuth, function (req, res, next) {
    // Verify that the passed in id to delete is the same as that in the auth token
    if (req.params.id !== req.auth.userId) {
        let err = new Error('Invalid request for saving story');
        err.status = 401;
        return next(err);
    }

    // Validate the body
    const schema = joi.object({
        contentSnippet: joi.string().max(300).required(),
        date: joi.date().required(),
        hours: joi.string().max(20),
        imageUrl: joi.string().max(300).required(),
        keep: joi.boolean().required(),
        link: joi.string().max(300).required(),
        source: joi.string().max(50).required(),
        storyID: joi.string().max(100).required(),
        title: joi.string().max(200).required()
    });
    schema.validateAsync(req.body)
        .then(value => { // eslint-disable-line no-unused-vars
            // This uses the MongoDB operators to test the savedStories array to make sure:
            // A. Story is not aready in there.
            // B. We limit the number of saved stories to 30
            // Not allowed at free tier!!!req.db.collection.findOneAndUpdate({ type: 'USER_TYPE', _id: ObjectId(req.auth.userId), $where: 'this.savedStories.length<29' },
            req.db.collection.findOneAndUpdate({ type: 'USER_TYPE', _id: ObjectId(req.auth.userId) },
                { $addToSet: { savedStories: req.body } },
                { returnDocument: "before" },
                function (err, result) {
                    if (result && result.value === null) {
                        let err = new Error('Over the save limit, or story already saved');
                        err.status = 403;
                        return next(err);
                    } else if (err) {
                        console.log("+++POSSIBLE save story CONTENTION ERROR?+++ err:", err);
                        err.status = 409;
                        return next(err);
                    } else if (result.acknowledged !== true && result.ok !== 1) {
                        console.log("+++POSSIBLE save story CONTENTION ERROR?+++ result:", result);
                        let err = new Error('Story save failure');
                        err.status = 409;
                        return next(err);
                    }

                    res.status(200).json(result.value);
                });

        })
        .catch(error => {
            error.status = 400;
            return next(error);
        });
});

// Delete a story from the save folder.

router.delete('/:id/savedstories/:sid', authHelper.checkAuth, function (req, res, next) {
    // Verify that the passed in id to delete is the same as that in the auth token
    if (req.params.id !== req.auth.userId) {
        let err = new Error('Invalid request for deletion of saved story');
        err.status = 401;
        return next(err);
    }


    req.db.collection.findOneAndUpdate({ type: 'USER_TYPE', _id: ObjectId(req.auth.userId) },
        { $pull: { savedStories: { storyID: req.params.sid } } },
        { returnDocument: "before" },
        function (err, result) {
            if (err) {
                console.log("+++POSSIBLE saved story delete CONTENTION ERROR?+++ err:", err);
                err.status = 400;
                return next(err);
            } else if (result.acknowledged !== true && result.ok !== 1) {
                console.log("+++POSSIBLE saved story delete CONTENTION ERROR?+++ result:", result);
                let err = new Error('Story delete failure');
                err.status = 409;
                return next(err);
            }

            res.status(200).json(result.value);
        });
});

module.exports = router;