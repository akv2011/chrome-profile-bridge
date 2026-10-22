const HEADLINE = {
  on: "Connected to the bridge",
  connecting: "Connecting to the bridge…",
  error: "Not connected",
  off: "Not connected",
};

const status = await chrome.runtime.sendMessage({ type: "getStatus" });
document.getElementById("dot").className = `dot ${status.state}`;
document.getElementById("headline").textContent = HEADLINE[status.state] ?? HEADLINE.off;
document.getElementById("email").textContent = status.email || "not signed in to Chrome";
document.getElementById("chats").textContent = String(status.chats);
document.getElementById("tabs").textContent = `${status.tabs} (${status.attached} being driven)`;
document.getElementById("version").textContent = status.version;
if (status.state !== "on") {
  document.getElementById("note").textContent =
    status.lastClose?.code === 4004
      ? "This profile is not signed in to Chrome, so the bridge cannot tell which profile it is."
      : "The bridge daemon is not answering on 127.0.0.1:18765. It runs under launchd as local.chrome-profile-bridge.";
}
