import React from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app"
import { ensureDesktopApi } from "./browser-shim"
import "./styles/tokens.css"
import "./styles/vendor/github-markdown-light.css"
import "./styles/vendor/github-markdown-dark.css"
import "./styles/app.css"

ensureDesktopApi()

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
