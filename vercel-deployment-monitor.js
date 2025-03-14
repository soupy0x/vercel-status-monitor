#!/usr/bin/env node

// Import packages with ESM dynamic import
import axios from "axios";
import ora from "ora";
import figlet from "figlet";
import clear from "clear";
import { Command } from "commander";
import dotenv from "dotenv";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import chalk from "chalk";

// Setup for package.json reading
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// Load environment variables
dotenv.config();

// Create command program
const program = new Command();

// CLI configuration
program
  .version("1.0.0")
  .description("A CLI tool to monitor Vercel deployment status")
  .option("-p, --project <project>", "Vercel project name or ID")
  .option(
    "-t, --token <token>",
    "Vercel API token (or set VERCEL_TOKEN env variable)",
  )
  .option("-i, --interval <seconds>", "Polling interval in seconds", "15")
  .option("-c, --count <number>", "Number of deployments to show", "5")
  .option("-v, --verbose", "Show all updates even when nothing changes")
  .parse(process.argv);

const options = program.opts();

// Get API token from options or environment variable
const apiToken = options.token || process.env.VERCEL_TOKEN;
const projectId = options.project || process.env.VERCEL_PROJECT;
const pollingInterval = parseInt(options.interval) * 1000;
const deploymentsToShow = parseInt(options.count);
const verboseMode = options.verbose || false;
const quietMode = !verboseMode; // Quiet by default

if (!apiToken) {
  console.error(
    chalk.red(
      "Error: Vercel API token is required. Provide it with --token or set VERCEL_TOKEN env variable.",
    ),
  );
  process.exit(1);
}

if (!projectId) {
  console.error(
    chalk.red(
      "Error: Vercel project ID/name is required. Provide it with --project or set VERCEL_PROJECT env variable.",
    ),
  );
  process.exit(1);
}

// Store previous deployments state for comparison
let previousDeployments = [];

// Vercel API configuration
const vercelAPI = axios.create({
  baseURL: "https://api.vercel.com",
  headers: {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  },
});

// Status color mapping
const statusColors = {
  READY: chalk.green,
  ERROR: chalk.red,
  BUILDING: chalk.yellow,
  QUEUED: chalk.yellow,
  CANCELED: chalk.gray,
  INITIALIZING: chalk.yellow,
};

// Function to format the deployment state with appropriate color
function formatState(state) {
  const colorFn = statusColors[state] || chalk.white;
  return colorFn(state);
}

// Function to format the deployment time
function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString();
}

// Function to get the elapsed time since deployment started
function getElapsedTime(createdAt) {
  const created = new Date(createdAt);
  const now = new Date();
  const elapsed = Math.floor((now - created) / 1000);

  if (elapsed < 60) {
    return `${elapsed}s`;
  } else if (elapsed < 3600) {
    return `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  } else {
    const hours = Math.floor(elapsed / 3600);
    const minutes = Math.floor((elapsed % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }
}

// Check if there are new deployments or status changes
function hasDeploymentChanges(currentDeployments) {
  if (previousDeployments.length === 0) return true;

  // Check for new deployments (by ID)
  const prevIds = new Set(previousDeployments.map((d) => d.uid));
  const hasNewDeployments = currentDeployments.some((d) => !prevIds.has(d.uid));

  if (hasNewDeployments) return true;

  // Check for status changes in existing deployments
  for (const current of currentDeployments) {
    const previous = previousDeployments.find((d) => d.uid === current.uid);
    if (previous && previous.state !== current.state) {
      return true;
    }
  }

  return false;
}

// Function to display deployments
function displayDeployments(deployments) {
  clear();
  // Create title with figlet using the slant font (simple but stylized)
  const title = figlet.textSync("Soupy Status", {
    font: "slant",
    horizontalLayout: "default",
  });

  // Apply orange color for the text
  console.log(chalk.hex("#FF8C00")(title));
  console.log(
    chalk.blue(
      `Monitoring deployments for project: ${chalk.white(projectId)}\n`,
    ),
  );

  if (deployments.length > 0) {
    console.log(chalk.white("Recent deployments:"));
    console.log(chalk.dim("─".repeat(80)));

    deployments.forEach((deployment) => {
      const state = formatState(deployment.state);
      const createdAt = formatTime(deployment.createdAt);
      const elapsedTime = getElapsedTime(deployment.createdAt);
      const commitMessage =
        deployment.meta?.githubCommitMessage || "No commit message";
      const commitRef = deployment.meta?.githubCommitRef || "-";

      console.log(
        `${state.padEnd(25)} | ${chalk.dim(createdAt)} (${elapsedTime})`,
      );
      console.log(`${chalk.dim("Branch:")} ${commitRef}`);
      console.log(`${chalk.dim("Message:")} ${commitMessage}`);

      // For active deployments, show more details
      if (
        deployment.state === "BUILDING" ||
        deployment.state === "INITIALIZING"
      ) {
        console.log(chalk.yellow(`Building...`));
      } else if (deployment.state === "READY") {
        console.log(chalk.green(`✓ Deployed to ${deployment.url}`));
      } else if (deployment.state === "ERROR") {
        console.log(chalk.red(`✗ Deployment failed`));
      }

      console.log(chalk.dim("─".repeat(80)));
    });
  } else {
    console.log(chalk.yellow("No deployments found for this project."));
  }

  console.log(
    `\n${chalk.dim(`Next update in ${options.interval} seconds...`)}`,
  );
  if (verboseMode) {
    console.log(chalk.dim("Running in verbose mode - showing all updates."));
  } else {
    console.log(
      chalk.dim(
        "Running in quiet mode - will only show updates when deployments change.",
      ),
    );
  }
}

// Function to fetch deployments and check for changes
async function fetchDeployments() {
  try {
    const spinner = !quietMode ? ora("Fetching deployments...").start() : null;

    const response = await vercelAPI.get(`/v6/deployments`, {
      params: {
        limit: deploymentsToShow,
        projectId: projectId,
      },
    });

    if (spinner) spinner.stop();

    const currentDeployments = response.data.deployments || [];
    const changes = hasDeploymentChanges(currentDeployments);

    // In quiet mode, only display if there are changes
    if (!quietMode || changes) {
      displayDeployments(currentDeployments);

      // If changes detected in quiet mode, show notification
      if (quietMode && changes && previousDeployments.length > 0) {
        // Determine what changed
        if (currentDeployments.length > 0 && previousDeployments.length > 0) {
          // Check for new deployments
          const prevIds = new Set(previousDeployments.map((d) => d.uid));
          const newDeployments = currentDeployments.filter(
            (d) => !prevIds.has(d.uid),
          );

          if (newDeployments.length > 0) {
            console.log(chalk.green("\n🔔 New deployment detected!"));
            newDeployments.forEach((d) => {
              const commitMsg =
                d.meta?.githubCommitMessage || "No commit message";
              console.log(
                chalk.white(`  • ${formatState(d.state)}: ${commitMsg}`),
              );
            });
          }

          // Check for status changes
          for (const current of currentDeployments) {
            const previous = previousDeployments.find(
              (d) => d.uid === current.uid,
            );
            if (previous && previous.state !== current.state) {
              console.log(chalk.blue(`\n🔄 Deployment status changed:`));
              console.log(
                chalk.white(
                  `  • ${previous.meta?.githubCommitMessage || "Deployment"}: ${formatState(previous.state)} → ${formatState(current.state)}`,
                ),
              );

              if (current.state === "READY") {
                console.log(
                  chalk.green(`  ✓ Successfully deployed to ${current.url}`),
                );
              } else if (current.state === "ERROR") {
                console.log(chalk.red(`  ✗ Deployment failed`));
              }
            }
          }
        }
      }
    } else {
      // In quiet mode with no changes, don't show anything
      // Just let the process continue silently
    }

    // Update previous deployments for next comparison
    previousDeployments = currentDeployments;
  } catch (error) {
    clear();
    console.error(chalk.red("Error fetching deployments:"));

    if (error.response) {
      // Vercel API responded with an error
      console.error(chalk.red(`Status: ${error.response.status}`));
      console.error(
        chalk.red(`Message: ${JSON.stringify(error.response.data)}`),
      );
    } else if (error.request) {
      // No response received
      console.error(
        chalk.red(
          "No response received from Vercel API. Check your internet connection.",
        ),
      );
    } else {
      // Other errors
      console.error(chalk.red(error.message));
    }

    console.log(`\n${chalk.dim(`Retrying in ${options.interval} seconds...`)}`);
  }
}

// Main function
async function main() {
  console.log(chalk.blue("Starting Vercel deployment monitor..."));

  if (quietMode) {
    console.log(
      chalk.dim(
        "Running in quiet mode - will only show updates when deployments change.",
      ),
    );
  }

  // Initial fetch
  await fetchDeployments();

  // Set up interval for continuous monitoring
  setInterval(fetchDeployments, pollingInterval);
}

// Start the application
main().catch((error) => {
  console.error(chalk.red("Fatal error:"), error);
  process.exit(1);
});
