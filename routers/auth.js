import argon2 from "argon2";
import { User } from "../models/user.js";
import express from "express";
import Joi from "joi";
import jwt from "jsonwebtoken";

const router = express.Router();

router.post("/", async (req, res) => {
    const { error } = validate(req.body);
    if (error) return res.status(400).send(error.message);

    let user = await User.findOne({ email: req.body.email });
    if (!user) return res.status(400).send("invalid email.");

    const validPassword = await argon2.verify(user.password, req.body.password);
    if (!validPassword) return res.status(400).send("incorrect password");

    req.session.userId = user._id;
    req.session.username = user.username;

    const token = jwt.sign(
        { _id: user._id },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
    );

    res.json({ token, username: user.username });
});

function validate(user) {
    const schema = Joi.object({
        email: Joi.string().min(2).max(50).email().required(),
        password: Joi.string().min(2).max(50).required()
    });
    return schema.validate(user);
}

export { router as auth };