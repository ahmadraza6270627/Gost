import Joi from "joi";
import passwordComplexity from "joi-password-complexity"
import mongoose from "mongoose";
const userSchema = new mongoose.Schema({
    username :{
        type : String,
        minlength : 2,
        maxlength : 50,
        required : true
    },
    email :{
        type : String,
        minlength : 4,
        maxlength : 50,
        required : true
    },
    password :{
        type : String,
        minlength : 4,
        maxlength : 1024,
        required : true
    },
    isAdmin : Boolean
})

export const User = mongoose.model("User",userSchema)

export function validate(user){
    const schema = Joi.object({
        username : Joi.string().min(2).required(),
        email : Joi.string().min(2).email().required(),
        password : passwordComplexity().required()
    })
    return schema.validate(user)
}

