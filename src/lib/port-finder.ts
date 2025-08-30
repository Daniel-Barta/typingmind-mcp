import net from 'net';

// List of ports to try in order
const PORTS = [50880, 50881];

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', () => {
      resolve(false);
    });

    server.once('listening', () => {
      server.close();
      resolve(true);
    });

    server.listen(port);
  });
}

export async function findAvailablePort(): Promise<number | null> {
  for (const port of PORTS) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  return null;
}
