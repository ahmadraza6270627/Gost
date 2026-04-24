import logger from "../startup/logging.js"

export function error(err,req,res,next){
 logger.error(err.message,{meta : err} )
 res.status(500).send("internal issue")    
}
