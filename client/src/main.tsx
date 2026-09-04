import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { toast, Toaster } from 'sonner';
import App from './App';
import { ErrorBoundary } from '@/components/common/ErrorBoundary';
import './index.css';

function describeQueryError(error: unknown): string {
  const response = (error as { response?: { data?: { error?: string } } })
    ?.response;
  return response?.data?.error || 'Something went wrong — please try again';
}

// Toast dedupe: Home fires three queries at once, so a dead server would
// otherwise produce three identical toasts simultaneously.
let lastToastMessage = '';
let lastToastAt = 0;

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      const message = describeQueryError(error);
      const now = Date.now();
      if (message === lastToastMessage && now - lastToastAt < 2000) return;
      lastToastMessage = message;
      lastToastAt = now;
      toast.error(message);
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
        <Toaster
          position="bottom-center"
          theme="dark"
          toastOptions={{
            style: {
              background: 'hsl(var(--card))',
              border: '1px solid hsl(var(--border))',
              color: 'hsl(var(--foreground))',
            },
          }}
        />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);