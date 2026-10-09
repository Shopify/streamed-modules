import React from 'react';
import {HashRouter, NavLink, Route, Routes} from 'react-router-dom';
import Dashboard from './views/Dashboard.jsx';
import Orders from './views/Orders.jsx';
import Inventory from './views/Inventory.jsx';
import Analytics from './views/Analytics.jsx';
import Docs from './views/Docs.jsx';
import Settings from './views/Settings.jsx';
import Timeline from './views/Timeline.jsx';
import {telemetry} from './lib/runtime.js';

const NAV = [
  ['/', 'Dashboard'],
  ['/orders', 'Orders'],
  ['/inventory', 'Inventory'],
  ['/analytics', 'Analytics'],
  ['/timeline', 'Timeline'],
  ['/docs', 'Docs'],
  ['/settings', 'Settings'],
];

export default function App() {
  const mode = telemetry.mode || 'unknown';
  return (
    <HashRouter>
      <div className="shell">
        <aside className="nav">
          <div className="nav__brand">
            <span className="nav__logo" />
            <div>
              <strong>Streamed Modules</strong>
              <em className={`nav__mode nav__mode--${mode}`}>{mode} build</em>
            </div>
          </div>
          <nav>
            {NAV.map(([to, label]) => (
              <NavLink key={to} to={to} end={to === '/'}>
                {label}
              </NavLink>
            ))}
          </nav>
          <footer className="nav__foot">
            <span>{telemetry.registered.length} feature modules</span>
            <span>{telemetry.modExec.length || 1} bundle modules</span>
          </footer>
        </aside>

        <main className="main">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/timeline" element={<Timeline />} />
            <Route path="/docs" element={<Docs />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
