import { validate, User } from "../models/user.js";
import express from "express";
import _ from "lodash";
import argon2 from "argon2";

const router = express.Router();

router.post("/", async (req, res) => {
    const { error } = validate(req.body);
    if (error) return res.status(400).send(error.message);

    let user = await User.findOne({ email: req.body.email });
    if (user) return res.status(400).send("user already exist");

    user = new User(_.pick(req.body, ["username", "email", "password"]));
    user.password = await argon2.hash(req.body.password);

    await user.save(); // Save first, then respond
    res.send(_.pick(user, ["username", "email"]));
});

export { router as user };
