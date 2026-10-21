import React, { createContext, useContext, useEffect, useState } from 'react';
import { storage } from '../utils/storage';
import { checkSession, login as loginRequest, logout as logoutRequest } from '../utils/auth';

const MoviesContext = createContext(null);

export function useMovies() {
  const context = useContext(MoviesContext);
  if (!context) throw new Error('useMovies must be used inside MoviesProvider');
  return context;
}

export function MoviesProvider({ children }) {
  const [movies, setMovies] = useState(() => {
    storage.initializeSampleData();
    return storage.getMovies();
  });
  const [favorites, setFavorites] = useState(() => storage.getFavorites());
  const [authState, setAuthState] = useState({ status: 'checking', username: null });

  // The admin session is verified by the server on load; nothing is trusted
  // from localStorage or from client-side state.
  useEffect(() => {
    let active = true;
    storage.purgeLegacyAdminState();
    checkSession().then((session) => {
      if (!active) return;
      setAuthState({
        status: session.authenticated ? 'authenticated' : 'anonymous',
        username: session.username,
      });
    });
    return () => { active = false; };
  }, []);

  // Keep multiple tabs of the same browser in sync.
  useEffect(() => {
    const sync = () => {
      setMovies(storage.getMovies());
      setFavorites(storage.getFavorites());
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  const addMovie = (movie) => {
    const result = storage.addMovie(movie);
    if (result.success) setMovies(storage.getMovies());
    return result;
  };

  const updateMovie = (id, changes) => {
    const success = storage.updateMovie(id, changes);
    if (success) setMovies(storage.getMovies());
    return success;
  };

  const deleteMovie = (id) => {
    const success = storage.deleteMovie(id);
    if (success) {
      setMovies(storage.getMovies());
      setFavorites(storage.getFavorites());
    }
    return success;
  };

  const toggleFavorite = (id) => {
    const result = storage.toggleFavorite(id);
    if (result.success) setFavorites(result.favorites);
    return result.success;
  };

  const login = async (username, password) => {
    const result = await loginRequest(username, password);
    if (result.success) {
      setAuthState({ status: 'authenticated', username: result.username || username });
    }
    return result;
  };

  const logout = async () => {
    await logoutRequest();
    setAuthState({ status: 'anonymous', username: null });
  };

  return (
    <MoviesContext.Provider value={{
      movies, favorites,
      isAdmin: authState.status === 'authenticated',
      authReady: authState.status !== 'checking',
      adminUsername: authState.username,
      addMovie, updateMovie, deleteMovie,
      toggleFavorite, login, logout,
      refreshMovies: () => setMovies(storage.getMovies()),
    }}>
      {children}
    </MoviesContext.Provider>
  );
}
