import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Clapperboard } from 'lucide-react';
import { useMovies } from '../context/MoviesContext';

// Route guard for the admin panel. The underlying session is issued and
// verified by the server (HttpOnly cookie); this only reflects that state.
export default function AdminRoute({ children }) {
  const { isAdmin, authReady } = useMovies();
  const location = useLocation();

  if (!authReady) {
    return (
      <main className="container-wide page-missing" aria-busy="true">
        <Clapperboard size={45} />
        <h1>جارٍ التحقق من الجلسة…</h1>
        <p>لحظة واحدة من فضلك.</p>
      </main>
    );
  }

  return isAdmin ? children : <Navigate to="/admin/login" state={{ from: location }} replace />;
}
