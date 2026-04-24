import mongoose from "mongoose"
import logger from "./logging.js"   // same startup/ folder — correct

export function db() {
    const mongoURI = process.env.MONGO_URI
    if (!mongoURI) throw new Error("MONGO_URI environment variable is not set")

    mongoose.connect(mongoURI)
        .then(() => console.log("Connected to MongoDB"))
        .catch((err) => logger.error(err.message, err))
}
