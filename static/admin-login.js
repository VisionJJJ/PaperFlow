const form = document.getElementById("adminLoginForm");
const usernameInput = document.getElementById("adminUsername");
const passwordInput = document.getElementById("adminPassword");
const message = document.getElementById("adminLoginMessage");
const submitButton = document.getElementById("adminLoginButton");

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function checkSession() {
  try {
    const session = await api("/api/admin/session");
    if (session.authenticated) {
      window.location.href = "/admin";
    }
  } catch {}
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
  submitButton.disabled = true;
  try {
    await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({
        username: usernameInput.value.trim(),
        password: passwordInput.value,
      }),
    });
    window.location.href = "/admin";
  } catch (error) {
    message.textContent = error.status === 401 ? "账号或密码错误。" : "登录失败，请稍后重试。";
  } finally {
    submitButton.disabled = false;
  }
});

checkSession();
