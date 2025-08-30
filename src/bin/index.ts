#!/usr/bin/env node

// Load .env variables if available
import "dotenv/config";
import chalk from "chalk";
import { start } from "../lib/server";

// Get auth token from command line arguments or environment variable
const authToken: string | undefined =
  process.argv[2] || process.env.MCP_AUTH_TOKEN;

if (!authToken) {
  console.error(chalk.red("Error: Authentication token is required"));
  console.log("Usage: npx @typingmind/mcp <auth-token>");
  console.log("       OR set MCP_AUTH_TOKEN environment variable");
  process.exit(1);
}

// Start the server with the provided auth token
start(authToken)
  .then(({ host, port, protocol }) => {
    console.log(
      chalk.green(
        `✓ MCP runner server running on ${protocol}://${host}:${port}`,
      ),
    );
    console.log(
      chalk.yellow(
        "Note: You must keep the server running in the background in order to use MCP in TypingMind.",
      ),
    );
  })
  .catch((err: Error) => {
    console.error(chalk.red(`Error starting MCP server: ${err.message}`));
    process.exit(1);
  });
