import "express-async-errors"
import winston from "winston"

const logger = winston.createLogger({
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        }),
        new winston.transports.File({ 
            filename: 'logs/error.log',
            level: 'error'
        })
    ]
})

process.on('uncaughtException', (ex) => {
    logger.error('Uncaught Exception: ' + ex.message, { meta: ex });
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection: ' + reason, { meta: reason });
});

export default logger
