const fs = require('fs').promises;
const readline = require('readline');
const chalk = require('chalk');
const { promisify } = require('util');
const { Client, Intents } = require('discord.js');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = promisify(rl.question).bind(rl);
const CONFIG_FILE = 'config.json';
const BANNER = chalk.cyan.bold(`
=======================================
       VOID TICKETS SETUP WIZARD      
=======================================
`);

// Helper function to validate Discord IDs
function isValidDiscordId(id) {
  return /^\d{18,20}$/.test(id);
}

// Helper function to validate bot token
function isValidBotToken(token) {
  return /^[\w-]{24,}\.[\w-]{6,}\.[\w-]{27,}$/.test(token);
}

// Helper function to load config
async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    console.error(chalk.red(`❌ Error reading ${CONFIG_FILE}: ${err.message}`));
    process.exit(1);
  }
}

// Helper function to save config
async function saveConfig(config) {
  try {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    console.log(chalk.green(`🎉 Configuration saved to ${CONFIG_FILE}!`));
  } catch (err) {
    console.error(chalk.red(`❌ Error saving ${CONFIG_FILE}: ${err.message}`));
    process.exit(1);
  }
}

// Helper function to validate Discord resources
async function validateDiscordResource(client, guildId, resourceId, type = 'channel') {
  try {
    const guild = await client.guilds.fetch(guildId);
    if (type === 'channel') {
      const channel = await guild.channels.fetch(resourceId);
      return channel ? true : false;
    } else if (type === 'role') {
      const role = await guild.roles.fetch(resourceId);
      return role ? true : false;
    }
    return false;
  } catch (err) {
    console.error(chalk.red(`❌ Error validating ${type} ${resourceId}: ${err.message}`));
    return false;
  }
}

// Helper function to prompt with validation
async function promptWithValidation(promptText, validator, defaultValue = null, optional = false, client = null, guildId = null, type = null) {
  while (true) {
    const input = await question(chalk.yellow(promptText) + (defaultValue ? chalk.gray(` [${defaultValue}]`) : '') + ': ');
    const trimmed = input.trim();

    if (trimmed.toLowerCase() === 'cancel' || trimmed.toLowerCase() === 'exit') {
      console.log(chalk.red('❌ Setup cancelled by user.'));
      rl.close();
      process.exit(0);
    }

    if (!trimmed && optional) return defaultValue;
    if (!trimmed && !optional) {
      console.log(chalk.red('❌ This field is required. Please provide a value or type "cancel" to exit.'));
      continue;
    }

    if (validator && !validator(trimmed)) {
      console.log(chalk.red('❌ Invalid input format. Please try again or type "cancel" to exit.'));
      continue;
    }

    if (client && guildId && type && isValidDiscordId(trimmed)) {
      const isValid = await validateDiscordResource(client, guildId, trimmed, type);
      if (!isValid) {
        console.log(chalk.red(`❌ Invalid ${type} ID: Not found in guild ${guildId}. Please try again.`));
        continue;
      }
    }

    return trimmed;
  }
}

// Main setup function
async function setupGuild() {
  console.log(BANNER);
  console.log(chalk.cyan('🚀 Welcome to the Void Tickets Setup Wizard! Follow the prompts to configure your bot.'));
  console.log(chalk.gray('Type "cancel" at any prompt to exit. Enable Developer Mode in Discord to copy IDs.\n'));

  // Initialize Discord client for validation
  const botToken = await promptWithValidation(
    'Enter Bot Token (shared across servers)',
    isValidBotToken,
    null,
    false
  );

  const client = new Client({ intents: [Intents.FLAGS.GUILDS] });
  try {
    console.log(chalk.yellow('🔑 Logging in to validate IDs...'));
    await client.login(botToken);
    console.log(chalk.green('✅ Bot logged in successfully!'));

    const guildId = await promptWithValidation(
      'Enter Guild ID',
      isValidDiscordId,
      null,
      false,
      client,
      null,
      'guild'
    );

    const configData = {
      guildId,
      staffRoleId: await promptWithValidation(
        'Enter Staff Role ID',
        isValidDiscordId,
        null,
        false,
        client,
        guildId,
        'role'
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
        true,
        client,
        guildId,
        'channel'
      ),
      panelChannelId: await promptWithValidation(
        'Enter Panel Channel ID (bot auto-sends panel here)',
        isValidDiscordId,
        null,
        false,
        client,
        guildId,
        'channel'
      ),
      logChannelId: await promptWithValidation(
        'Enter Log Channel ID (optional)',
        isValidDiscordId,
        null,
        true,
        client,
        guildId,
        'channel'
      ),
      chiefOpsId: await promptWithValidation(
        'Enter Chief of Operations Role ID (optional)',
        isValidDiscordId,
        null,
        true,
        client,
        guildId,
        'role'
      ),
      coOwnerId: await promptWithValidation(
        'Enter Co-Owner Role ID (optional)',
        isValidDiscordId,
        null,
        true,
        client,
        guildId,
        'role'
      ),
      ownerId: await promptWithValidation(
        'Enter Owner Role ID (optional)',
        isValidDiscordId,
        null,
        true,
        client,
        guildId,
        'role'
      ),
      logServerId: await promptWithValidation(
        'Enter Log Server ID (optional, for transcript logging)',
        isValidDiscordId,
        null,
        true,
        client,
        null,
        'guild'
      ),
      timeoutMinutes: await promptWithValidation(
        'Enter Auto-Close Timeout (minutes, default 360)',
        input => !isNaN(input) && parseInt(input) > 0,
        '360',
        true
      )
    };

    // Destroy client after validation
    await client.destroy();
    console.log(chalk.green('🔒 Bot logged out after validation.'));

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
      console.log(chalk.red('❌ Setup cancelled. Configuration not saved.'));
      rl.close();
      return;
    }

    // Load and update config
    const config = await loadConfig();
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
      autoCloseTimeout: parseInt(configData.timeoutMinutes) * 60
    };

    await saveConfig(config);
    console.log(chalk.green(`🎉 Setup complete for Guild ID ${configData.guildId}! Configuration saved.`));
    rl.close();
  } catch (err) {
    console.error(chalk.red(`❌ Error during setup: ${err.message}`));
    await client.destroy();
    rl.close();
    process.exit(1);
  }
}

// Run setup
(async () => {
  try {
    await setupGuild();
  } catch (err) {
    console.error(chalk.red(`❌ Unexpected error during setup: ${err.message}`));
    rl.close();
    process.exit(1);
  }
})();
