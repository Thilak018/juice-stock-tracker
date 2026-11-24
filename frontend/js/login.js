(function () {
  'use strict';

  // DOM references
  var form = document.getElementById('loginForm');
  var userInput = document.getElementById('username');
  var passInput = document.getElementById('password');
  var errorBox = document.getElementById('loginError');
  var btn = document.getElementById('loginBtn');
  var spin = document.getElementById('loginSpin');
  var toggle = document.getElementById('togglePw');

  function showError(msg) {
    errorBox.textContent = msg; // textContent: never inject server text as HTML
    errorBox.classList.remove('d-none');
  }

  function setBusy(busy) {
    btn.disabled = busy;
    spin.classList.toggle('d-none', !busy);
  }

  toggle.addEventListener('click', function () {
    var show = passInput.type === 'password';
    passInput.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorBox.classList.add('d-none');
    form.classList.add('was-validated');
    if (!form.checkValidity()) return;

    setBusy(true);
    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username: userInput.value.trim(), password: passInput.value })
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || ('Server returned HTTP ' + res.status));
          window.location.href = '/';
        });
      })
      .catch(function (err) {
        showError(err.message === 'Failed to fetch' ? 'Cannot reach the server.' : err.message);
        passInput.value = '';
        passInput.focus();
        form.classList.remove('was-validated');
        setBusy(false);
      });
  });
})();
