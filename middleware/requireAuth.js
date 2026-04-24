export function requireAuth(req, res, next) {
    if (req.session && req.session.userId) {
        return next(); // Valid session, allow access
    }
    res.redirect("/"); // No session, redirect to login
}
