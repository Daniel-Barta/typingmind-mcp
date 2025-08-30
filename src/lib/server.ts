import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import stringify from 'json-stable-stringify';
import cors from 'cors';
import fs from 'fs';
import https from 'https';
import { findAvailablePort } from './port-finder';
import { authMiddleware } from './auth';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

type ClientConfig = {
  command?: string;
  url?: string;
  args?: string[];
  env?: Record<string, string>;
};

type ClientEntry = {
  id: string;
  client: Client;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  config: ClientConfig;
  createdAt: Date;
};

// Store active MCP clients
const clients = new Map<string, ClientEntry>();

const createRemoteClient = async ({ clientId, url }: { clientId: string; url: string }) => {
  let client: Client | undefined;
  const baseUrl = new URL(url);
  try {
    client = new Client({
      name: `mcp-streamable-http-bridge-${clientId}`,
      version: '1.0.0',
    });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);
    console.log('Connected using Streamable HTTP transport');
  } catch (_error) {
    console.log('Streamable HTTP connection failed, falling back to SSE transport');
    client = new Client({
      name: `mcp-sse-http-bridge-${clientId}`,
      version: '1.0.0',
    });
    const sseTransport = new SSEClientTransport(baseUrl);
    await client.connect(sseTransport);
    console.log('Connected using SSE transport');
  }

  return client!;
};

async function startClient(clientId: string, config: ClientConfig) {
  const { command, url, args = [], env = {} } = config;

  if (!command && !url) {
    throw new Error('command or url is required');
  }

  let client: Client;

  if (command) {
    const transport = new StdioClientTransport({
      command,
      args,
      env: Object.values(env).length > 0 ? { ...getDefaultEnvironment(), ...env } : undefined,
    });

    client = new Client({ name: `mcp-http-bridge-${clientId}`, version: '1.0.0' });
    await client.connect(transport);
  } else if (url) {
    client = await createRemoteClient({ clientId, url });
  } else {
    throw new Error('Either command or url must be provided');
  }

  clients.set(clientId, {
    id: clientId,
    client,
    command,
    args,
    env,
    config, // Store original config for restart
    createdAt: new Date(),
  });

  return {
    id: clientId,
    message: 'MCP client started successfully',
  };
}

export async function start(authToken: string): Promise<{ port: number; host: string; protocol: 'http' | 'https' }> {
  const app = express();

  const portFromEnv = process.env.PORT ? Number(process.env.PORT) : undefined;
  const port = portFromEnv || (await findAvailablePort());
  if (!port) {
    throw new Error('No available ports found. Please specify a port by using the PORT environment variable.');
  }

  app.use(cors());
  app.use(express.json());

  const auth = authMiddleware(authToken);

  app.get('/ping', auth, (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  app.post('/start', auth, async (req: Request, res: Response) => {
    try {
      const { mcpServers } = req.body as { mcpServers: Record<string, ClientConfig> };

      const results: { success: Array<{ id: string; message: string }>; errors: Array<{ id: string; error: string }> } = {
        success: [],
        errors: [],
      };

      const startPromises = Object.entries(mcpServers || {}).map(async ([serverId, config]) => {
        try {
          if (clients.has(serverId)) {
            const hasConfigChanged = stringify(clients.get(serverId)!.config) !== stringify(config);
            if (!hasConfigChanged) {
              return;
            }
            console.log('Restarting client with new config:', serverId);
            await clients.get(serverId)!.client.close();
          }

          const result = await startClient(serverId, config);
          results.success.push(result);
        } catch (error: any) {
          console.error(`Failed to initialize client ${serverId}:`, error);
          results.errors.push({ id: serverId, error: `Failed to initialize: ${error.message}` });
        }
      });

      await Promise.all(startPromises);

      if (results.errors.length === 0) {
        return res.status(201).json({ message: 'All MCP clients started successfully', clients: results.success });
      } else {
        return res.status(400).json({ message: 'Some MCP clients failed to start', success: results.success, errors: results.errors });
      }
    } catch (error: any) {
      console.error('Error starting clients:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/restart/:id', auth, async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const clientEntry = clients.get(id);

    if (!clientEntry) {
      return res.status(404).json({ error: 'Client not found' });
    }

    try {
      const config: ClientConfig = clientEntry.config || {
        command: clientEntry.command,
        args: clientEntry.args,
        env: clientEntry.env,
      };

      await clientEntry.client.close();
      clients.delete(id);

      const result = await startClient(id, config);

      return res.status(200).json({ message: `Client ${id} restarted successfully`, client: result });
    } catch (error: any) {
      console.error(`Error restarting client ${id}:`, error);
      return res.status(500).json({ error: 'Failed to restart client', details: error.message });
    }
  });

  app.get('/clients', auth, async (_req: Request, res: Response) => {
    try {
      const clientDetailsPromises = Array.from(clients.values()).map(async (clientEntry) => {
        const { id, command, args, createdAt } = clientEntry;

        try {
          const result = await clientEntry.client.listTools();
          const tools = result.tools || [];
          const toolNames = tools.map((tool: any) => tool.name as string);

          return { id, command, args, createdAt, tools: toolNames };
        } catch (error: any) {
          console.error(`Error getting tools for client ${id}:`, error);
          return { id, command, args, createdAt, tools: [] as string[], toolError: error.message };
        }
      });

      const clientsList = await Promise.all(clientDetailsPromises);

      res.status(200).json(clientsList);
    } catch (error: any) {
      console.error('Error fetching clients list:', error);
      res.status(500).json({ error: 'Failed to retrieve clients list', details: error.message });
    }
  });

  app.get('/clients/:id', auth, (req: Request, res: Response) => {
    const clientId = (req.params as { id: string }).id;
    const clientEntry = clients.get(clientId);

    if (!clientEntry) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const { id, command, args, createdAt } = clientEntry;

    res.status(200).json({ id, command, args, createdAt });
  });

  app.get('/clients/:id/tools', auth, async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const clientEntry = clients.get(id);

    if (!clientEntry) {
      return res.status(404).json({ error: 'Client not found' });
    }

    try {
      const result = await clientEntry.client.listTools();
      res.status(200).json(result.tools);
    } catch (error: any) {
      console.error(`Error getting tools for client ${id}:`, error);
      res.status(500).json({ error: 'Failed to get tools', details: error.message });
    }
  });

  app.post('/clients/:id/call_tools', auth, async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const { name, arguments: toolArgs } = req.body as { name: string; arguments?: Record<string, unknown> };

    if (!name) {
      return res.status(400).json({ error: 'Tool name is required' });
    }

    const clientEntry = clients.get(id);
    if (!clientEntry) {
      return res.status(404).json({ error: 'Client not found' });
    }

    try {
      const result = await clientEntry.client.callTool({ name, arguments: toolArgs || {} });
      res.status(200).json(result);
    } catch (error: any) {
      console.error(`Error calling tool for client ${id}:`, error);
      res.status(500).json({ error: 'Failed to call tool', details: error.message });
    }
  });

  app.delete('/clients/:id', auth, async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const clientEntry = clients.get(id);

    if (!clientEntry) {
      return res.status(404).json({ error: 'Client not found' });
    }

    try {
      await clientEntry.client.close();
      clients.delete(id);

      res.status(200).json({ message: 'Client deleted successfully' });
    } catch (error: any) {
      console.error(`Error deleting client ${id}:`, error);
      res.status(500).json({ error: 'Failed to delete client', details: error.message });
    }
  });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  });

  return new Promise((resolve, reject) => {
    const host = process.env.HOST || '0.0.0.0';

    const certFile = process.env.CERTFILE;
    const keyFile = process.env.KEYFILE;

  type Closable = { close: (cb?: () => void) => void };
  let server: (https.Server & Closable) | (ReturnType<typeof app.listen> & Closable);

    if (certFile && keyFile) {
      try {
        const httpsOptions = { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };

        server = https.createServer(httpsOptions, app);
        server.listen(port, host, () => {
          resolve({ port, host, protocol: 'https' });
        });
      } catch (error) {
        console.error('Error setting up HTTPS server:', error);
        reject(error);
      }
    } else {
      server = app.listen(port, host, () => {
        resolve({ port, host, protocol: 'http' });
      });
    }

    process.on('SIGINT', () => {
      console.log('\nShutting down MCP server...');
      server.close(() => {
        process.exit(0);
      });
    });
  });
}

process.on('SIGINT', async () => {
  console.log('Shutting down server...');

  for (const [id, clientEntry] of clients.entries()) {
    try {
      await clientEntry.client.close();
      console.log(`Closed client ${id}`);
    } catch (error) {
      console.error(`Error closing client ${id}:`, error);
    }
  }

  process.exit(0);
});

export default { start };
