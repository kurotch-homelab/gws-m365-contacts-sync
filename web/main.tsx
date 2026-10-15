import React from 'react';
import { createRoot } from 'react-dom/client';
createRoot(document.getElementById('root')!).render(
  <main>
    <h1>Contacts Sync</h1>
    <p>Private Google and Microsoft contact synchronization.</p>
    <a href="/auth/google/login">Sign in with Google</a> ·{' '}
    <a href="/auth/microsoft/login">Sign in with Microsoft</a>
  </main>,
);
