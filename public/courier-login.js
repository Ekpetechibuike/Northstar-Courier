const loginForm = document.querySelector("#courier-login-form");
const passwordInput = document.querySelector("#courier-password");
const loginButton = document.querySelector("#courier-login-button");
const loginMessage = document.querySelector("#courier-login-message");

fetch("/api/courier/session")
  .then((response) => response.ok ? response.json() : null)
  .then((session) => {
    if (session?.authenticated) {
      const trackingNumber = new URLSearchParams(window.location.search).get("tracking");
      const destination = new URL("/courier.html", window.location.origin);
      if (trackingNumber) destination.searchParams.set("tracking", trackingNumber);
      window.location.replace(destination);
    }
  })
  .catch((error) => {
    console.error("Could not check courier portal session:", error);
  });

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginMessage.textContent = "";
  loginMessage.classList.remove("courier-message-error");
  loginButton.disabled = true;
  loginButton.textContent = "Signing in…";

  try {
    const response = await fetch("/api/courier/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: passwordInput.value })
    });
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error("The courier service returned an invalid response. Please try again.");
    }
    if (!response.ok) throw new Error(payload.error || "Sign-in failed. Please try again.");

    const trackingNumber = new URLSearchParams(window.location.search).get("tracking");
    const destination = new URL("/courier.html", window.location.origin);
    if (trackingNumber) destination.searchParams.set("tracking", trackingNumber);
    window.location.replace(destination);
  } catch (error) {
    loginMessage.textContent = error instanceof TypeError
      ? "Could not connect to the courier service. Check your connection and try again."
      : error.message;
    loginMessage.classList.add("courier-message-error");
    passwordInput.select();
  } finally {
    loginButton.disabled = false;
    loginButton.innerHTML = 'Sign in <span aria-hidden="true">→</span>';
  }
});
