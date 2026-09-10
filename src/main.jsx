import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import "./i18n/index.js";
import App from "./App.jsx";
import { AuthProvider } from "./context/AuthContext.jsx";
import { initPwa } from "./lib/pwa.js";

initPwa();

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
