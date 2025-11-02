"use client";

import { useEffect } from 'react';

const ServiceWorkerRegister = () => {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }
    navigator.serviceWorker
      .register('/service-worker.js')
      .catch((err) => console.warn('Service worker registration failed:', err));
  }, []);
  return null;
};

export default ServiceWorkerRegister;
