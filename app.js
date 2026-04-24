import 'dotenv/config'
import express from 'express'
import { db } from "./startup/db.js";
import { _config } from "./startup/config.js";
import { routers } from "./startup/routers.js";

const app = express()

routers(app)
db()
_config()

export default app
//const port = process.env.PORT || 5000
//app.listen(port, console.log(`listening on port ${port}...`))
