const { Client, Intents, MessageEmbed, MessageActionRow, MessageButton, Permissions } = require('discord.js');
const fs = require('fs').promises;
const winston = require('winston');
const { setTimeout } = require('timers/promises');

// Initialize logger first
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log' })
  ]
});

const CONFIG_FILE = 'config.json';
const startTime = Date.now();

function loadConfig() {
  try {
    const data = fs.readFileSync(CONFIG_FILE, 'utf8');
    const configData = JSON.parse(data);
    for (const guildId of Object.keys(configData)) {
      if (!configData[guildId].panelChannelId || !configData[guildId].staffRoleId) {
        logger.error(`Invalid config for guild ${guildId}: Missing panelChannelId or staffRoleId`);
        process.exit(1);
      }
    }
    return configData;
  } catch (err) {
    logger.error(`Error reading ${CONFIG_FILE}: ${err.message}`);
    process.exit(1);
  }
}

// Load config after logger initialization
let config = loadConfig();

async function saveConfig() {
  try {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    logger.info(`Configuration saved to ${CONFIG_FILE}`);
  } catch (err) {
    logger.error(`Error saving ${CONFIG_FILE}: ${err.message}`);
  }
}

const client = new Client({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MESSAGES,
    Intents.FLAGS.GUILD_MESSAGE_REACTIONS
  ]
});

const activeTickets = new Map();

// ---------- Auto Panel Creation / Management ----------
async function sendOrUpdatePanel(guildId) {
  const guildConfig = config[guildId];
  if (!guildConfig || !guildConfig.panelChannelId) {
    logger.error(`No valid config or panelChannelId for guild ${guildId}`);
    return;
  }

  try {
    const guild = await client.guilds.fetch(guildId).catch(err => {
      logger.error(`Failed to fetch guild ${guildId}: ${err.message}`);
      return null;
    });
    if (!guild) return;

    // Log all channels for debugging
    const channels = await guild.channels.fetch().catch(err => {
      logger.error(`Failed to fetch channels for guild ${guildId}: ${err.message}`);
      return new Map();
    });
    logger.info(`Channels in guild ${guildId}: ${Array.from(channels.keys()).join(', ')}`);

    let panelChannel;
    let retryCount = 0;
    const maxRetries = 3;
    const retryDelay = 5000;

    while (!panelChannel && retryCount < maxRetries) {
      try {
        panelChannel = await guild.channels.fetch(guildConfig.panelChannelId);
        if (panelChannel.guildId !== guildId) {
          logger.error(`Channel ${guildConfig.panelChannelId} does not belong to guild ${guildId}`);
          panelChannel = null;
        }
      } catch (err) {
        logger.warn(`Failed to fetch panel channel ${guildConfig.panelChannelId} (Attempt ${retryCount + 1}/${maxRetries}): ${err.message}`);
      }

      if (!panelChannel) {
        retryCount++;
        if (retryCount < maxRetries) {
          logger.info(`Retrying channel fetch in ${retryDelay / 1000} seconds...`);
          await setTimeout(retryDelay);
        }
      }
    }

    // Fallback: Create a new panel channel
    if (!panelChannel) {
      try {
        panelChannel = await guild.channels.create('void-tickets-panel', {
          type: 'GUILD_TEXT',
          permissionOverwrites: [
            { id: guild.id, deny: ['SEND_MESSAGES'], allow: ['VIEW_CHANNEL'] },
            { id: client.user.id, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'EMBED_LINKS', 'MANAGE_MESSAGES'] }
          ]
        });
        guildConfig.panelChannelId = panelChannel.id;
        await saveConfig();
        logger.info(`Created new panel channel ${panelChannel.id} for guild ${guildId}`);
        if (guildConfig.logChannelId) {
          const logChannel = await client.channels.fetch(guildConfig.logChannelId).catch(() => null);
          if (logChannel) {
            await logChannel.send(`⚠️ Original panel channel ${guildConfig.panelChannelId} was invalid. Created new channel: <#${panelChannel.id}>`);
          }
        }
      } catch (err) {
        logger.error(`Failed to create panel channel for guild ${guildId}: ${err.message}`);
        if (guildConfig.logChannelId) {
          const logChannel = await client.channels.fetch(guildConfig.logChannelId).catch(() => null);
          if (logChannel) {
            await logChannel.send(`❌ Failed to create panel channel for guild ${guildId}: ${err.message}`);
          }
        }
        return;
      }
    }

    // Verify bot permissions
    const botMember = await guild.members.fetch(client.user.id).catch(err => {
      logger.error(`Failed to fetch bot member for guild ${guildId}: ${err.message}`);
      return null;
    });
    if (!botMember) return;

    const requiredPermissions = ['VIEW_CHANNEL', 'SEND_MESSAGES', 'EMBED_LINKS'];
    const permissions = panelChannel.permissionsFor(botMember);
    const missingPermissions = requiredPermissions.filter(perm => !permissions.has(perm));
    if (missingPermissions.length > 0) {
      logger.error(`Bot lacks permissions (${missingPermissions.join(', ')}) in channel ${panelChannel.id}`);
      if (guildConfig.logChannelId) {
        const logChannel = await client.channels.fetch(guildConfig.logChannelId).catch(() => null);
        if (logChannel) {
          await logChannel.send(`⚠️ Bot lacks permissions (${missingPermissions.join(', ')}) in <#${panelChannel.id}>. Please update permissions.`);
        }
      }
      return;
    }

    // Check if panel exists
    let panelMessage;
    if (guildConfig.panelMessageId) {
      try {
        panelMessage = await panelChannel.messages.fetch(guildConfig.panelMessageId);
      } catch (err) {
        logger.warn(`Panel message ${guildConfig.panelMessageId} not found, creating new one`);
        panelMessage = null;
      }
    }

    // Check for custom emoji
    const openEmoji = guild.emojis.cache.find(e => e.name.toLowerCase().includes('ticket')) || '🛠️';
    const faqEmoji = guild.emojis.cache.find(e => e.name.toLowerCase().includes('faq')) || '❓';

    const embed = new MessageEmbed()
      .setTitle('🎟️ Void Tickets Support')
      .setDescription('Need help? Click **Open Ticket** to start a support session! 📩')
      .addField('Status', '🟢 Online', true)
      .addField('Support Team', `<@&${guildConfig.staffRoleId}>`, true)
      .addField('Active Tickets', activeTickets.size.toString(), true)
      .setColor('#00BFFF')
      .setAuthor({ name: guild.name, iconURL: guild.iconURL() || client.user.displayAvatarURL() })
      .setThumbnail(client.user.displayAvatarURL())
      .setFooter({ text: 'Void Tickets | Powered by xAI', iconURL: client.user.displayAvatarURL() })
      .setTimestamp();

    const row = new MessageActionRow()
      .addComponents(
        new MessageButton()
          .setCustomId('open_void_ticket')
          .setLabel('Open Ticket')
          .setEmoji(openEmoji)
          .setStyle('PRIMARY'),
        new MessageButton()
          .setCustomId('view_faq')
          .setLabel('View FAQ')
          .setEmoji(faqEmoji)
          .setStyle('SECONDARY')
      );

    if (!panelMessage) {
      const message = await panelChannel.send({ embeds: [embed], components: [row] }).catch(err => {
        logger.error(`Failed to send panel message in channel ${panelChannel.id}: ${err.message}`);
        return null;
      });
      if (message) {
        guildConfig.panelMessageId = message.id;
        await saveConfig();
        logger.info(`Panel created in guild ${guildId} in channel ${panelChannel.id}`);
      }
    } else {
      await panelMessage.edit({ embeds: [embed], components: [row] }).catch(err => {
        logger.error(`Failed to edit panel message ${panelMessage.id}: ${err.message}`);
      });
      logger.info(`Panel updated in guild ${guildId}`);
    }

    // Send welcome message
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const welcomeEmbed = new MessageEmbed()
      .setTitle('🚀 Void Tickets Bot Online')
      .setDescription(`Void Tickets is ready to assist in ${guild.name}! Use the buttons below to open a ticket or view the FAQ.`)
      .addField('Uptime', `${Math.floor(uptime / 60)}m ${uptime % 60}s`, true)
      .addField('Version', '1.0.0', true)
      .setColor('#00BFFF')
      .setThumbnail(client.user.displayAvatarURL())
      .setTimestamp();
    await panelChannel.send({ embeds: [welcomeEmbed] }).catch(err => {
      logger.error(`Failed to send welcome message in channel ${panelChannel.id}: ${err.message}`);
    });
  } catch (err) {
    logger.error(`Unexpected error in sendOrUpdatePanel for guild ${guildId}: ${err.message}`);
  }
}

// ---------- Bot Ready ----------
client.once('ready', async () => {
  logger.info(`🚀 Logged in as ${client.user.tag}!`);
  // Register slash commands
  const commands = [
    {
      name: 'reload-config',
      description: 'Reload the bot configuration (staff only)',
      defaultPermission: false
    },
    {
      name: 'diagnose',
      description: 'Diagnose bot configuration issues (staff only)',
      defaultPermission: false
    },
    {
      name: 'status',
      description: 'Show bot status and statistics (staff only)',
      defaultPermission: false
    }
  ];
  try {
    await client.application.commands.set(commands);
    logger.info('Slash commands registered');
  } catch (err) {
    logger.error(`Failed to register slash commands: ${err.message}`);
  }
  for (const guildId of Object.keys(config)) {
    await sendOrUpdatePanel(guildId);
  }
  autocloseTickets.start();
});

// ---------- Interaction Handling ----------
client.on('interactionCreate', async interaction => {
  if (interaction.isCommand()) {
    const guildConfig = config[interaction.guild?.id];
    if (!guildConfig) {
      await interaction.reply({ content: '⚠️ No configuration found for this guild.', ephemeral: true });
      return;
    }
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) {
      await interaction.reply({ content: '⚠️ Failed to fetch member data.', ephemeral: true });
      return;
    }
    const roles = await member.roles.fetch().catch(() => new Map());
    if (!roles.has(guildConfig.staffRoleId)) {
      await interaction.reply({ content: '⛔ Only staff can use this command.', ephemeral: true });
      return;
    }

    if (interaction.commandName === 'reload-config') {
      config = loadConfig();
      await sendOrUpdatePanel(interaction.guild.id);
      await interaction.reply({ content: '✅ Configuration reloaded!', ephemeral: true });
      logger.info(`Config reloaded by ${interaction.user.tag} in guild ${interaction.guild.id}`);
    } else if (interaction.commandName === 'diagnose') {
      const guild = interaction.guild;
      const channels = await guild.channels.fetch().catch(() => new Map());
      const channelExists = channels.has(guildConfig.panelChannelId);
      const botMember = await guild.members.fetch(client.user.id).catch(() => null);
      const permissions = botMember && guildConfig.panelChannelId ? channels.get(guildConfig.panelChannelId)?.permissionsFor(botMember) : null;
      const missingPermissions = permissions ? ['VIEW_CHANNEL', 'SEND_MESSAGES', 'EMBED_LINKS'].filter(perm => !permissions.has(perm)) : [];

      const embed = new MessageEmbed()
        .setTitle('🛠️ Bot Diagnosis')
        .setDescription('Diagnostic results for Void Tickets configuration.')
        .addField('Guild', guild.name, true)
        .addField('Panel Channel ID', guildConfig.panelChannelId, true)
        .addField('Channel Exists', channelExists ? '✅ Yes' : '❌ No', true)
        .addField('Bot Permissions', missingPermissions.length === 0 ? '✅ All present' : `❌ Missing: ${missingPermissions.join(', ')}`, true)
        .addField('Staff Role', `<@&${guildConfig.staffRoleId}>`, true)
        .setColor('#FFD700')
        .setThumbnail(client.user.displayAvatarURL())
        .setTimestamp();
      await interaction.reply({ embeds: [embed], ephemeral: true });
      logger.info(`Diagnosis run by ${interaction.user.tag} in guild ${guild.id}`);
    } else if (interaction.commandName === 'status') {
      const uptime = Math.floor((Date.now() - startTime) / 1000);
      const embed = new MessageEmbed()
        .setTitle('📊 Void Tickets Status')
        .setDescription('Current status and statistics for Void Tickets.')
        .addField('Uptime', `${Math.floor(uptime / 60)}m ${uptime % 60}s`, true)
        .addField('Active Tickets', activeTickets.size.toString(), true)
        .addField('Guild', interaction.guild.name, true)
        .addField('Version', '1.0.0', true)
        .setColor('#00BFFF')
        .setThumbnail(client.user.displayAvatarURL())
        .setTimestamp();
      await interaction.reply({ embeds: [embed], ephemeral: true });
      logger.info(`Status checked by ${interaction.user.tag} in guild ${interaction.guild.id}`);
    }
    return;
  }

  if (!interaction.isButton()) return;

  const guildId = interaction.guild?.id?.toString();
  const guildConfig = config[guildId];
  if (!guildConfig) {
    await interaction.reply({ content: '⚠️ No configuration found for this guild.', ephemeral: true });
    return;
  }

  const userId = interaction.user.id;

  if (interaction.customId === 'open_void_ticket') {
    if (activeTickets.has(userId)) {
      await interaction.reply({ content: '⛔ You already have an open ticket!', ephemeral: true });
      return;
    }

    let category;
    if (guildConfig.categoryId) {
      category = await interaction.guild.channels.fetch(guildConfig.categoryId).catch(err => {
        logger.error(`Failed to fetch category ${guildConfig.categoryId}: ${err.message}`);
        return null;
      });
    } else {
      const channels = await interaction.guild.channels.fetch();
      category = Array.from(channels.values()).find(c => c.name === 'Void Tickets' && c.type === 'GUILD_CATEGORY');
    }

    if (!category) {
      try {
        category = await interaction.guild.channels.create('Void Tickets', {
          type: 'GUILD_CATEGORY',
          permissionOverwrites: [{ id: interaction.guild.id, deny: ['VIEW_CHANNEL'] }]
        });
      } catch (err) {
        logger.error(`Failed to create category for guild ${guildId}: ${err.message}`);
        await interaction.reply({ content: '⚠️ Failed to create ticket category.', ephemeral: true });
        return;
      }
    }

    const channelName = `${guildConfig.channelPrefix || 'ticket-'}${interaction.user.username}-${userId % 10000}`;
    let channel;
    try {
      channel = await interaction.guild.channels.create(channelName, {
        type: 'GUILD_TEXT',
        parent: category,
        permissionOverwrites: [
          { id: interaction.guild.id, deny: ['VIEW_CHANNEL'] },
          { id: userId, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'] },
          { id: client.user.id, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'] },
          { id: guildConfig.staffRoleId, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'] }
        ]
      });
    } catch (err) {
      logger.error(`Failed to create ticket channel for user ${userId}: ${err.message}`);
      await interaction.reply({ content: '⚠️ Failed to create ticket channel.', ephemeral: true });
      return;
    }

    activeTickets.set(userId, { channelId: channel.id, guildId, userId, lastActivity: Date.now(), claimedBy: null });

    const ticketEmoji = interaction.guild.emojis.cache.find(e => e.name.toLowerCase().includes('ticket')) || '🎟️';
    const embed = new MessageEmbed()
      .setTitle(`${ticketEmoji} Void Tickets - Support Ticket`)
      .setDescription(`Welcome, <@${userId}>! Our staff will assist you soon.`)
      .addField('Ticket ID', channel.id, true)
      .addField('Created By', `<@${userId}>`, true)
      .addField('Status', '🟢 Open', true)
      .setColor('#00BFFF')
      .setAuthor({ name: interaction.guild.name, iconURL: interaction.guild.iconURL() || client.user.displayAvatarURL() })
      .setThumbnail(client.user.displayAvatarURL())
      .setFooter({ text: 'Void Tickets | Powered by xAI', iconURL: client.user.displayAvatarURL() })
      .setTimestamp();

    const row = new MessageActionRow()
      .addComponents(
        new MessageButton().setCustomId('close_void_ticket').setLabel('Close').setEmoji('🔒').setStyle('DANGER'),
        new MessageButton().setCustomId('claim_void_ticket').setLabel('Claim').setEmoji('👷').setStyle('PRIMARY'),
        new MessageButton().setCustomId('request_help_void_ticket').setLabel('Call Management').setEmoji('📢').setStyle('SECONDARY'),
        new MessageButton().setCustomId('get_void_transcript').setLabel('Transcript').setEmoji('📜').setStyle('SECONDARY')
      );

    await channel.send({ content: `<@${userId}> <@&${guildConfig.staffRoleId}>`, embeds: [embed], components: [row] }).catch(err => {
      logger.error(`Failed to send initial ticket message in channel ${channel.id}: ${err.message}`);
    });

    if (guildConfig.logChannelId) {
      const logChannel = await client.channels.fetch(guildConfig.logChannelId).catch(() => null);
      if (logChannel) await logChannel.send(`🎟️ Ticket created: <#${channel.id}> by <@${userId}>`);
    }

    await interaction.reply({ content: `✅ Your ticket has been created: <#${channel.id}>`, ephemeral: true });
  } else if (interaction.customId === 'view_faq') {
    const embed = new MessageEmbed()
      .setTitle('❓ Void Tickets FAQ')
      .setDescription('**Common Questions**\n- **Response Time?** Usually within minutes.\n- **Reopen Ticket?** Create a new one.\n- **Transcripts?** Available via the Transcript button.')
      .setColor('#FFD700')
      .setThumbnail(client.user.displayAvatarURL())
      .setFooter({ text: 'Void Tickets | Powered by xAI', iconURL: client.user.displayAvatarURL() })
      .setTimestamp();
    await interaction.reply({ embeds: [embed], ephemeral: true });
  } else if (interaction.customId === 'close_void_ticket') {
    const ticket = activeTickets.get(interaction.channel.id) || Object.values(activeTickets).find(t => t.channelId === interaction.channel.id);
    if (!ticket) return interaction.reply({ content: '⛔ No ticket data found.', ephemeral: true });

    const member = await interaction.guild.members.fetch(interaction.user.id).catch(err => {
      logger.error(`Failed to fetch member ${interaction.user.id}: ${err.message}`);
      return null;
    });
    if (!member) return interaction.reply({ content: '⚠️ Failed to fetch member data.', ephemeral: true });

    const roles = await member.roles.fetch().catch(() => new Map());
    if (!roles.has(guildConfig.staffRoleId)) return interaction.reply({ content: '⛔ Only staff can close tickets.', ephemeral: true });

    await interaction.deferReply();
    const transcriptPath = await generateHtmlTranscript(interaction.channel);
    const embed = new MessageEmbed()
      .setTitle('🔒 Ticket Closing')
      .setDescription('This ticket will close in 10 seconds. Transcript attached.')
      .setColor('#FF4500')
      .setThumbnail(client.user.displayAvatarURL())
      .setFooter({ text: 'Void Tickets | Powered by xAI', iconURL: client.user.displayAvatarURL() })
      .setTimestamp();
    await interaction.followUp({ embeds: [embed], files: [transcriptPath] });
    await fs.unlink(transcriptPath).catch(err => logger.error(`Failed to delete transcript: ${err.message}`));

    if (guildConfig.logChannelId) {
      const logChannel = await client.channels.fetch(guildConfig.logChannelId).catch(() => null);
      if (logChannel) await logChannel.send(`🔒 Ticket closed: <#${interaction.channel.id}> by <@${interaction.user.id}>`);
    }

    activeTickets.delete(ticket.userId);
    await setTimeout(10000);
    await interaction.channel.delete().catch(err => logger.error(`Cannot delete channel ${interaction.channel.id}: ${err.message}`));
  } else if (interaction.customId === 'claim_void_ticket') {
    const ticket = activeTickets.get(interaction.channel.id) || Object.values(activeTickets).find(t => t.channelId === interaction.channel.id);
    if (!ticket) return;

    const member = await interaction.guild.members.fetch(interaction.user.id).catch(err => {
      logger.error(`Failed to fetch member ${interaction.user.id}: ${err.message}`);
      return null;
    });
    if (!member) return interaction.reply({ content: '⚠️ Failed to fetch member data.', ephemeral: true });

    const roles = await member.roles.fetch().catch(() => new Map());
    if (!roles.has(guildConfig.staffRoleId)) return interaction.reply({ content: '⛔ Only staff can claim tickets.', ephemeral: true });

    ticket.claimedBy = interaction.user.id;
    const newChannelName = `${guildConfig.channelPrefix || 'ticket-'}claimed-${interaction.user.username}-${ticket.userId % 10000}`;
    await interaction.channel.setName(newChannelName);

    await interaction.channel.permissionOverwrites.set([
      { id: interaction.guild.id, deny: ['VIEW_CHANNEL'] },
      { id: guildConfig.staffRoleId, deny: ['VIEW_CHANNEL'] },
      { id: ticket.userId, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'] },
      { id: interaction.user.id, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'] }
    ]);

    await interaction.reply({ content: `👷 Ticket claimed by <@${interaction.user.id}>.`, ephemeral: true });
  } else if (interaction.customId === 'request_help_void_ticket') {
    const ticket = activeTickets.get(interaction.channel.id) || Object.values(activeTickets).find(t => t.channelId === interaction.channel.id);
    if (!ticket) return;

    const row = new MessageActionRow()
      .addComponents(
        new MessageButton().setCustomId('management_Chief of Operations').setLabel('Chief of Operations').setEmoji('👑').setStyle('PRIMARY'),
        new MessageButton().setCustomId('management_Co-Owner').setLabel('Co-Owner').setEmoji('👑').setStyle('PRIMARY'),
        new MessageButton().setCustomId('management_Owner').setLabel('Owner').setEmoji('👑').setStyle('PRIMARY')
      );

    const embed = new MessageEmbed()
      .setTitle('📢 Call Management')
      .setDescription('Select a management role to request assistance.')
      .setColor('#00BFFF')
      .setThumbnail(client.user.displayAvatarURL())
      .setFooter({ text: 'Void Tickets | Powered by xAI', iconURL: client.user.displayAvatarURL() })
      .setTimestamp();
    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  } else if (interaction.customId === 'get_void_transcript') {
    const ticket = activeTickets.get(interaction.channel.id) || Object.values(activeTickets).find(t => t.channelId === interaction.channel.id);
    if (!ticket) return;

    await interaction.deferReply({ ephemeral: true });
    const transcriptPath = await generateHtmlTranscript(interaction.channel);
    const embed = new MessageEmbed()
      .setTitle('📜 Ticket Transcript')
      .setDescription('Here is the current transcript of this ticket.')
      .setColor('#FFD700')
      .setThumbnail(client.user.displayAvatarURL())
      .setFooter({ text: 'Void Tickets | Powered by xAI', iconURL: client.user.displayAvatarURL() })
      .setTimestamp();
    await interaction.followUp({ embeds: [embed], files: [transcriptPath], ephemeral: true });
    await fs.unlink(transcriptPath).catch(err => logger.error(`Failed to delete transcript: ${err.message}`));
  } else if (interaction.customId.startsWith('management_')) {
    const ticket = activeTickets.get(interaction.channel.id) || Object.values(activeTickets).find(t => t.channelId === interaction.channel.id);
    if (!ticket) return;

    const roleName = interaction.customId.split('_')[1];
    const roleId = guildConfig.highStaffRoles?.[roleName];
    if (roleId) {
      const role = await interaction.guild.roles.fetch(roleId).catch(err => {
        logger.error(`Failed to fetch role ${roleId}: ${err.message}`);
        return null;
      });
      if (role) {
        await interaction.channel.send(`📢 <@&${roleId}> has been called for assistance.`);
        await interaction.update({ content: `✅ Requested ${roleName} assistance.`, components: [] });
      } else {
        await interaction.update({ content: `⛔ Role ${roleName} not found.`, components: [] });
      }
    } else {
      await interaction.update({ content: `⛔ No role ID configured for ${roleName}.`, components: [] });
    }
  }
});

// ---------- Autoclose Tickets ----------
const autocloseTickets = {
  interval: null,
  start() {
    this.interval = setInterval(async () => {
      const now = Date.now();
      for (const [userId, ticket] of activeTickets) {
        const timeout = config[ticket.guildId]?.autoCloseTimeout || 21600;
        if ((now - ticket.lastActivity) / 1000 > timeout) {
          const channel = await client.channels.fetch(ticket.channelId).catch(() => null);
          if (!channel) continue;

          const transcriptPath = await generateHtmlTranscript(channel);
          const embed = new MessageEmbed()
            .setTitle('🔒 Ticket Auto-Closed')
            .setDescription('This ticket has been closed due to inactivity.')
            .setColor('#FF4500')
            .setThumbnail(client.user.displayAvatarURL())
            .setFooter({ text: 'Void Tickets | Powered by xAI', iconURL: client.user.displayAvatarURL() })
            .setTimestamp();
          await channel.send({ embeds: [embed], files: [transcriptPath] });
          await fs.unlink(transcriptPath).catch(err => logger.error(`Failed to delete transcript: ${err.message}`));

          if (config[ticket.guildId].logChannelId) {
            const logChannel = await client.channels.fetch(config[ticket.guildId].logChannelId).catch(() => null);
            if (logChannel) await logChannel.send(`🔒 Ticket auto-closed: <#${channel.id}>`);
          }

          activeTickets.delete(userId);
          await setTimeout(10000);
          await channel.delete().catch(err => logger.error(`Cannot delete channel ${channel.id}: ${err.message}`));
        }
      }
    }, 60000);
  },
  stop() { clearInterval(this.interval); }
};

// ---------- Track Activity ----------
client.on('messageCreate', message => {
  const ticket = Object.values(activeTickets).find(t => t.channelId === message.channel.id);
  if (ticket && !message.author.bot) ticket.lastActivity = Date.now();
});

// ---------- Transcript Generation ----------
async function generateHtmlTranscript(channel) {
  const transcriptPath = `transcript_${channel.id}.html`;
  let htmlContent = `
    <html>
    <head>
      <title>Transcript for ${channel.name}</title>
      <style>
        body { font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 20px; }
        .message { margin-bottom: 10px; padding: 10px; border-radius: 5px; background-color: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .user { font-weight: bold; color: #333; }
        .timestamp { color: #888; font-size: 0.8em; }
        .content { margin-top: 5px; }
        .attachment { color: #007bff; }
      </style>
    </head>
    <body>
      <h1>Transcript for ${channel.name}</h1>
      <p>Channel ID: ${channel.id}</p>
      <p>Generated: ${new Date().toLocaleString()}</p>
      <hr>
  `;

  const messages = await channel.messages.fetch({ limit: 100 });
  messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp).forEach(message => {
    const timestamp = new Date(message.createdTimestamp).toLocaleString();
    const author = `${message.author.username}#${message.author.discriminator}`;
    const content = message.content.replace(/</g, '&lt;').replace(/>/g, '&gt;') || '[No text content]';
    const attachments = message.attachments.map(att => `<div class="attachment">Attachment: <a href="${att.url}">${att.name}</a></div>`).join('');
    htmlContent += `<div class="message"><span class="user">${author}</span> <span class="timestamp">[${timestamp}]</span><div class="content">${content}</div>${attachments}</div>`;
  });

  htmlContent += '</body></html>';
  await fs.writeFile(transcriptPath, htmlContent);
  return transcriptPath;
}

// ---------- Login ----------
const firstGuildId = Object.keys(config)[0];
if (firstGuildId && config[firstGuildId].botToken) {
  client.login(config[firstGuildId].botToken).catch(err => {
    logger.error(`Failed to login with bot token: ${err.message}`);
    process.exit(1);
  });
} else {
  logger.error('No valid bot token found in config. Please run "npm run setup" first.');
  process.exit(1);
}
