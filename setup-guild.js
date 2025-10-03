const fs = require('fs').promises; // Use promises for async file operations
const readline = require('readline');
const chalk = require('chalk');
const { promisify } = require('util');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Promisify rl.question for async/await
const question = promisify(rl.question).bind(rl);
const CONFIG_FILE = 'config.json';

// ANSI art banner for a cool look
const BANNER = chalk.cyan.bold(`
=======================================
       VOID TICKETS SETUP WIZARD      
=======================================
`);

// Helper function to validate Discord IDs (18-20 digits)
function isValidDiscordId(id) {
  return /^\d{18,20}$/.test(id);
}

// Helper function to validate bot token (basic format check)
function isValidBotToken(token) {
  return /^[\w-]{24,}\.[\w-]{6,}\.[\w-]{27,}$/.test(token);
}

// Helper function to load config with error handling
async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {};
    }
    console.error(chalk.red(`Error reading ${CONFIG_FILE}: ${err.message}`));
    process.exit(1);
  }
}

// Helper function to save config with error handling
async function saveConfig(config) {
  try {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    console.log(chalk.green(`🎉 Configuration saved to ${CONFIG_FILE}!`));
  } catch (err) {
    console.error(chalk.red(`Error saving ${CONFIG_FILE}: ${err.message}`));
    process.exit(1);
  }
}

// Helper function to prompt with validation
async function promptWithValidation(promptText, validator, defaultValue = null, optional = false) {
  while (true) {
    const input = await question(chalk.yellow(promptText) + (defaultValue ? chalk.gray(` [${defaultValue}]`) : '') + ': ');
    const trimmed = input.trim();

    if (trimmed.toLowerCase() === 'cancel' || trimmed.toLowerCase() === 'exit') {
      console.log(chalk.red('Setup cancelled by user.'));
      rl.close();
      process.exit(0);
    }

    if (!trimmed && optional) {
      return defaultValue;
    }

    if (!trimmed && !optional) {
      console.log(chalk.red('This field is required. Please provide a value or type "cancel" to exit.'));
      continue;
    }

    if (!validator || validator(trimmed)) {
      return trimmed;
    }

    console.log(chalk.red('Invalid input. Please try again or type "cancel" to exit.'));
  }
}

// Main setup function
async function setupGuild() {
  console.log(BANNER);
  console.log(chalk.cyan('Welcome to the Void Tickets Setup Wizard! Follow the prompts to configure your bot.'));
  console.log(chalk.gray('Type "cancel" at any prompt to exit.\n'));

  // Collect configuration
  const configData = {
    botToken: await promptWithValidation(
      'Enter Bot Token (shared across servers)',
      isValidBotToken,
      null,
      false
    ),
    guildId: await promptWithValidation(
      'Enter Guild ID',
      isValidDiscordId,
      null,
      false
    ),
    staffRoleId: await promptWithValidation(
      'Enter Staff Role ID',
      isValidDiscordId,
      null,
      false
    ),
    channelPrefix: await promptWithValidation(
      'Enter Ticket Channel Name Prefix',
      prefix => prefix.length > 0 && /^[a-zA-Z0-9-]+$/.test(prefix),
      'ticket-',
      true
    ),
    categoryId: await promptWithValidation(
      'Enter Category ID for Tickets (optional)',
      isValidDiscordId,
      null,
      true
    ),
    panelChannelId: await promptWithValidation(
      'Enter Panel Channel ID (bot auto-sends panel here)',
      isValidDiscordId,
      null,
      false
    ),
    logChannelId: await promptWithValidation(
      'Enter Log Channel ID (optional)',
      isValidDiscordId,
      null,
      true
    ),
    chiefOpsId: await promptWithValidation(
      'Enter Chief of Operations Role ID (optional)',
      isValidDiscordId,
      null,
      true
    ),
    coOwnerId: await promptWithValidation(
      'Enter Co-Owner Role ID (optional)',
      isValidDiscordId,
      null,
      true
    ),
    ownerId: await promptWithValidation(
      'Enter Owner Role ID (optional)',
      isValidDiscordId,
      null,
      true
    ),
    logServerId: await promptWithValidation(
      'Enter Log Server ID (optional, for transcript logging)',
      isValidDiscordId,
      null,
      true
    ),
    timeoutMinutes: await promptWithValidation(
      'Enter Auto-Close Timeout (minutes, default 360)',
      input => !isNaN(input) && parseInt(input) > 0,
      '360',
      true
    )
  };

  // Display configuration for confirmation
  console.log(chalk.cyan('\n📋 Please review your configuration:'));
  console.log(chalk.gray('-----------------------------------'));
  console.log(chalk.white(`Bot Token: ${chalk.gray('********' + configData.botToken.slice(-4))}`));
  console.log(chalk.white(`Guild ID: ${configData.guildId}`));
  console.log(chalk.white(`Staff Role ID: ${configData.staffRoleId}`));
  console.log(chalk.white(`Channel Prefix: ${configData.channelPrefix}`));
  console.log(chalk.white(`Category ID: ${configData.categoryId || 'Not set'}`));
  console.log(chalk.white(`Panel Channel ID: ${configData.panelChannelId}`));
  console.log(chalk.white(`Log Channel ID: ${configData.logChannelId || 'Not set'}`));
  console.log(chalk.white(`Chief of Operations Role ID: ${configData.chiefOpsId || 'Not set'}`));
  console.log(chalk.white(`Co-Owner Role ID: ${configData.coOwnerId || 'Not set'}`));
  console.log(chalk.white(`Owner Role ID: ${configData.ownerId || 'Not set'}`));
  console.log(chalk.white(`Log Server ID: ${configData.logServerId || 'Not set'}`));
  console.log(chalk.white(`Auto-Close Timeout: ${configData.timeoutMinutes} minutes`));
  console.log(chalk.gray('-----------------------------------'));

  // Confirm save
  const confirm = await promptWithValidation(
    'Save configuration? (yes/no)',
    input => ['yes', 'no', 'y', 'n'].includes(input.toLowerCase()),
    'yes',
    true
  );

  if (['no', 'n'].includes(confirm.toLowerCase())) {
    console.log(chalk.red('Setup cancelled. Configuration not saved.'));
    rl.close();
    return;
  }

  // Load existing config
  const config = await loadConfig();

  // Update config for the guild
  config[configData.guildId] = {
    botToken: configData.botToken,
    staffRoleId: parseInt(configData.staffRoleId),
    channelPrefix: configData.channelPrefix,
    categoryId: configData.categoryId ? parseInt(configData.categoryId) : null,
    panelChannelId: parseInt(configData.panelChannelId),
    logChannelId: configData.logChannelId ? parseInt(configData.logChannelId) : null,
    highStaffRoles: {
      'Chief of Operations': configData.chiefOpsId ? parseInt(configData.chiefOpsId) : null,
      'Co-Owner': configData.coOwnerId ? parseInt(configData.coOwnerId) : null,
      'Owner': configData.ownerId ? parseInt(configData.ownerId) : null
    },
    logServerId: configData.logServerId ? parseInt(configData.logServerId) : null,
    autoCloseTimeout: parseInt(configData.timeoutMinutes) * 60 // Convert to seconds
  };

  // Save config
  await saveConfig(config);
  console.log(chalk.green(`Setup complete for Guild ID ${configData.guildId}! Configuration saved.`));
  rl.close();
}

// Run setup and handle errors
(async () => {
  try {
    await setupGuild();
  } catch (err) {
    console.error(chalk.red(`Unexpected error during setup: ${err.message}`));
    rl.close();
    process.exit(1);
  }
})();
