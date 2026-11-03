"use client";

import { createAuthClient } from "better-auth/react";

// Browser-side helper for the login form and sign-out button. With no baseURL
// it calls /api/auth on the page's own origin, which is what keeps the Origin
// check satisfied. It never sees the session cookie: that is HttpOnly.
export const authClient = createAuthClient();
