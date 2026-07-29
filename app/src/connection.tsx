// App-wide connection state. Loads any saved connection on boot and exposes it
// plus setters through a context, so every screen knows whether we're paired.

import React, { createContext, useContext, useEffect, useState } from 'react';
import { Connection, loadConnection, clearConnection, getConnection } from './api';

interface Ctx {
  ready: boolean;          // finished the initial load attempt
  connection: Connection | null;
  setConnection: (c: Connection | null) => void;
  disconnect: () => Promise<void>;
}

const ConnectionContext = createContext<Ctx>({
  ready: false,
  connection: null,
  setConnection: () => {},
  disconnect: async () => {},
});

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [connection, setConn] = useState<Connection | null>(null);

  useEffect(() => {
    loadConnection().then((c) => {
      setConn(c || getConnection());
      setReady(true);
    });
  }, []);

  const setConnection = (c: Connection | null) => setConn(c);

  const disconnect = async () => {
    await clearConnection();
    setConn(null);
  };

  return (
    <ConnectionContext.Provider value={{ ready, connection, setConnection, disconnect }}>
      {children}
    </ConnectionContext.Provider>
  );
}

export function useConnection() {
  return useContext(ConnectionContext);
}
