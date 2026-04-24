document.addEventListener('DOMContentLoaded', function () {

    const API_BASE = window.API_BASE || '';

    document.getElementById('signin-submit').addEventListener('click', async function (event) {
        event.preventDefault();

        const email = document.getElementById('signin-email').value;
        const password = document.getElementById('signin-pass').value;

        const response = await fetch(`${API_BASE}/auth/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        if (response.ok) {
            const data = await response.json();
            sessionStorage.setItem('authToken', data.token);
            sessionStorage.setItem('username', data.username);
            sessionStorage.setItem('sessionId', data.sessionId); // ✅ save sessionId
            window.location.href = '/p2p.html';
        } else {
            const errorMessage = await response.text();
            alert(`Error: ${errorMessage}`);
        }
    });

    document.getElementById('signup-submit').addEventListener('click', async function (event) {
        event.preventDefault();

        const email = document.getElementById('signup-email').value;
        const username = document.getElementById('signup-username').value;
        const password = document.getElementById('signup-pass').value;

        const response = await fetch(`${API_BASE}/user/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, username, password })
        });

        if (response.ok) {
            alert('Sign Up Successful');
        } else {
            const errorMessage = await response.text();
            alert(`Error: ${errorMessage}`);
        }
    });
});