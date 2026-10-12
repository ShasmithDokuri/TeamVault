import { useEffect, useState } from 'react';

export default function App() {
  const [apiStatus, setApiStatus] = useState('checking');

  useEffect(() => {
    let active = true;

    fetch('/api/health')
      .then((response) => {
        if (!response.ok) throw new Error('API request failed');
        return response.json();
      })
      .then((result) => {
        if (active) setApiStatus(result.status === 'ok' ? 'connected' : 'unavailable');
      })
      .catch(() => {
        if (active) setApiStatus('unavailable');
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="page-shell">
      <section className="welcome-card" aria-labelledby="welcome-title">
        <div className="brand-mark" aria-hidden="true">TV</div>
        <p className="eyebrow">Team collaboration, in one place</p>
        <h1 id="welcome-title">Welcome to TeamVault</h1>
        <p className="intro">
          Your workspace for bringing teams, projects, and tasks together.
        </p>
        <div className="service-status" role="status" aria-live="polite">
          <span className={`status-dot ${apiStatus}`} aria-hidden="true" />
          API {apiStatus === 'checking' ? 'checking' : apiStatus}
        </div>
      </section>
    </main>
  );
}
