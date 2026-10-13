document.getElementById("grant").addEventListener("click", async () => {
  const result = document.getElementById("result");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    stream.getTracks().forEach((t) => t.stop());
    result.textContent = "Done! You can close this tab and press Join call.";
  } catch (err) {
    result.className = "error";
    result.textContent =
      err.name === "NotAllowedError"
        ? "Permission was blocked. Click the camera icon in the address bar to allow it, then try again."
        : `Couldn't access camera/mic: ${err.message || err.name}`;
  }
});
