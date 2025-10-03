const { Client, Intents, MessageEmbed, MessageActionRow, MessageButton } = require('discord.js');
const fs = require('fs');
const { setTimeout } = require('timers/promises');

const client = new Client({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MESSAGES,
    Intents.FLAGS.GUILD_MESSAGE_REACTIONS
  ]
});

const CONFIG_FILE = 'config.json';
let config = loadConfig();

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error('No configuration found. Please run "node setup-guild.js" first.');
    process.exit(1);
  }
  const configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  // Validate config structure
  for (const guildId of Object.keys(configData)) {
    if (!configData[guildId].panelChannelId || !configData[guildId].staffRoleId) {
      console.error(`Invalid config for guild ${guildId}: Missing panelChannelId or staffRoleId`);
      process.exit(1);
    }
  }
  return configData;
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

const activeTickets = new Map();
const INACTIVITY_TIMEOUT = 21600; // 6 hours in seconds

// ---------- Auto Panel Creation / Management ----------
async function sendOrUpdatePanel(guildId) {
  const guildConfig = config[guildId];
  if (!guildConfig || !guildConfig.panelChannelId) {
    console.error(`No valid config or panelChannelId for guild ${guildId}`);
    return;
  }

  try {
    const guild = await client.guilds.fetch(guildId).catch(err => {
      console.error(`Failed to fetch guild ${guildId}:`, err);
      return null;
    });
    if (!guild) return;

    // Fetch the panel channel
    const panelChannel = await guild.channels.fetch(guildConfig.panelChannelId).catch(err => {
      console.error(`Failed to fetch panel channel ${guildConfig.panelChannelId} for guild ${guildId}:`, err);
      return null;
    });
    if (!panelChannel) {
      console.error(`Channel ${guildConfig.panelChannelId} not found or inaccessible for guild ${guildId}`);
      return;
    }

    // Verify bot permissions
    const botMember = await guild.members.fetch(client.user.id).catch(err => {
      console.error(`Failed to fetch bot member for guild ${guildId}:`, err);
      return null;
    });
    if (!botMember) return;

    const requiredPermissions = ['VIEW_CHANNEL', 'SEND_MESSAGES', 'EMBED_LINKS'];
    const hasPermissions = panelChannel.permissionsFor(botMember).has(requiredPermissions);
    if (!hasPermissions) {
      console.error(`Bot lacks required permissions in channel ${panelChannel.id} for guild ${guildId}`);
      return;
    }

    // Check if panel exists and is still valid
    let panelMessage;
    if (guildConfig.panelMessageId) {
      try {
        panelMessage = await panelChannel.messages.fetch(guildConfig.panelMessageId);
      } catch (err) {
        console.warn(`Panel message ${guildConfig.panelMessageId} not found in channel ${panelChannel.id}, creating new one`);
        panelMessage = null;
      }
    }

    const embed = new MessageEmbed()
      .setTitle('Void Tickets')
      .setDescription('Click the button below to open a new ticket.')
      .setColor('#0066CC')
      .setAuthor({ name: 'Void Tickets', iconURL: client.user.displayAvatarURL() || undefined });

    const row = new MessageActionRow()
      .addComponents(
        new MessageButton()
          .setCustomId('open_void_ticket')
          .setLabel('Open Ticket')
          .setStyle('PRIMARY')
      );

    if (!panelMessage) {
      const message = await panelChannel.send({ embeds: [embed], components: [row] }).catch(err => {
        console.error(`Failed to send panel message in channel ${panelChannel.id}:`, err);
        return null;
      });
      if (message) {
        guildConfig.panelMessageId = message.id;
        saveConfig();
        console.log(`Panel created in guild ${guildId} in channel ${panelChannel.id}`);
      }
    } else {
      await panelMessage.edit({ embeds: [embed], components: [row] }).catch(err => {
        console.error(`Failed to edit panel message ${panelMessage.id} in guild ${guildId}:`, err);
      });
      console.log(`Panel updated in guild ${guildId}`);
    }
  } catch (err) {
    console.error(`Unexpected error in sendOrUpdatePanel for guild ${guildId}:`, err);
  }
}

// ---------- Bot Ready ----------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  // Send or update panels for all guilds
  for (const guildId of Object.keys(config)) {
    await sendOrUpdatePanel(guildId);
  }

  autocloseTickets.start();
});

// ---------- Interaction Handling ----------
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  const guildId = interaction.guild?.id?.toString();
  const guildConfig = config[guildId];
  if (!guildConfig) {
    await interaction.reply({ content: 'No configuration found for this guild.', ephemeral: true });
    return;
  }

  const userId = interaction.user.id;

  // ---------- Open Ticket ----------
  if (interaction.customId === 'open_void_ticket') {
    if (activeTickets.has(userId)) {
      await interaction.reply({ content: 'You already have an open ticket!', ephemeral: true });
      return;
    }

    // Determine category
    let category;
    if (guildConfig.categoryId) {
      category = await interaction.guild.channels.fetch(guildConfig.categoryId).catch(err => {
        console.error(`Failed to fetch category ${guildConfig.categoryId} for guild ${guildId}:`, err);
        return null;
      });
    } else {
      // Fetch all channels and find the "Void Tickets" category
      const channels = await interaction.guild.channels.fetch().catch(err => {
        console.error(`Failed to fetch channels for guild ${guildId}:`, err);
        return new Map();
      });
      category = Array.from(channels.values()).find(c => c.name === 'Void Tickets' && c.type === 'GUILD_CATEGORY');
    }

    if (!category) {
      try {
        category = await interaction.guild.channels.create('Void Tickets', {
          type: 'GUILD_CATEGORY',
          permissionOverwrites: [{ id: interaction.guild.id, deny: ['VIEW_CHANNEL'] }]
        });
      } catch (err) {
        console.error(`Failed to create category for guild ${guildId}:`, err);
        await interaction.reply({ content: 'Failed to create ticket category. Please contact an admin.', ephemeral: true });
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
      console.error(`Failed to create ticket channel for user ${userId} in guild ${guildId}:`, err);
      await interaction.reply({ content: 'Failed to create ticket channel. Please contact an admin.', ephemeral: true });
      return;
    }

    activeTickets.set(userId, { channelId: channel.id, guildId, userId, lastActivity: Date.now(), claimedBy: null });

    const embed = new MessageEmbed()
      .setTitle(`Void Tickets - Support Ticket`)
      .setDescription('Our staff will be with you shortly, please state your issue.')
      .setColor('#0066CC')
      .setAuthor({ name: 'Void Tickets', iconURL: client.user.displayAvatarURL() || undefined });

    const row = new MessageActionRow()
      .addComponents(
        new MessageButton().setCustomId('close_void_ticket').setLabel('Close').setStyle('DANGER'),
        new MessageButton().setCustomId('claim_void_ticket').setLabel('Claim').setStyle('PRIMARY'),
        new MessageButton().setCustomId('request_help_void_ticket').setLabel('Call Management').setStyle('SECONDARY'),
        new MessageButton().setCustomId('get_void_transcript').setLabel('Transcript').setStyle('SECONDARY')
      );

    await channel.send({ content: `<@${userId}> <@&${guildConfig.staffRoleId}>`, embeds: [embed], components: [row] }).catch(err => {
      console.error(`Failed to send initial ticket message in channel ${channel.id}:`, err);
    });

    if (guildConfig.logChannelId) {
      const logChannel = await client.channels.fetch(guildConfig.logChannelId).catch(() => null);
      if (logChannel) await logChannel.send(`Ticket created: <#${channel.id}> by <@${userId}>`);
    }

    await interaction.reply({ content: `Your ticket has been created: <#${channel.id}>`, ephemeral: true });
  }

  // ---------- Close Ticket ----------
  else if (interaction.customId === 'close_void_ticket') {
    const ticket = activeTickets.get(interaction.channel.id) || Object.values(activeTickets).find(t => t.channelId === interaction.channel.id);
    if (!ticket) return interaction.reply({ content: 'No ticket data found.', ephemeral: true });

    // Fetch member roles to check for staff role
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(err => {
      console.error(`Failed to fetch member ${interaction.user.id} in guild ${guildId}:`, err);
      return null;
    });
    if (!member) return interaction.reply({ content: 'Failed to fetch member data.', ephemeral: true });

    const roles = await member.roles.fetch().catch(err => {
      console.error(`Failed to fetch roles for member ${interaction.user.id}:`, err);
      return new Map();
    });
    if (!roles.has(guildConfig.staffRoleId)) return interaction.reply({ content: 'Only staff can close tickets.', ephemeral: true });

    await interaction.deferReply();
    const transcriptPath = await generateHtmlTranscript(interaction.channel);
    await interaction.followUp({ content: 'Ticket closing in 10 seconds. Transcript attached.', files: [transcriptPath] });
    fs.unlinkSync(transcriptPath);

    if (guildConfig.logChannelId) {
      const logChannel = await client.channels.fetch(guildConfig.logChannelId).catch(() => null);
      if (logChannel) await logChannel.send(`Ticket closed: <#${interaction.channel.id}> by <@${interaction.user.id}>`);
    }

    activeTickets.delete(ticket.userId);
    await setTimeout(10000);
    await interaction.channel.delete().catch(() => console.log(`Cannot delete channel ${interaction.channel.id}`));
  }

  // ---------- Claim Ticket ----------
  else if (interaction.customId === 'claim_void_ticket') {
    const ticket = activeTickets.get(interaction.channel.id) || Object.values(activeTickets).find(t => t.channelId === interaction.channel.id);
    if (!ticket) return;

    // Fetch member roles to check for staff role
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(err => {
      console.error(`Failed to fetch member ${interaction.user.id} in guild ${guildId}:`, err);
      return null;
    });
    if (!member) return interaction.reply({ content: 'Failed to fetch member data.', ephemeral: true });

    const roles = await member.roles.fetch().catch(err => {
      console.error(`Failed to fetch roles for member ${interaction.user.id}:`, err);
      return new Map();
    });
    if (!roles.has(guildConfig.staffRoleId)) return interaction.reply({ content: 'Only staff can claim tickets.', ephemeral: true });

    ticket.claimedBy = interaction.user.id;
    const newChannelName = `${guildConfig.channelPrefix || 'ticket-'}claimed-${interaction.user.username}-${ticket.userId % 10000}`;
    await interaction.channel.setName(newChannelName);

    const everyoneRole = await interaction.guild.roles.fetch(interaction.guild.id).catch(err => {
      console.error(`Failed to fetch everyone role for guild ${guildId}:`, err);
      return null;
    });
    if (!everyoneRole) return interaction.reply({ content: 'Failed to fetch everyone role.', ephemeral: true });

    await interaction.channel.permissionOverwrites.set([
      { id: everyoneRole.id, deny: ['VIEW_CHANNEL'] },
      { id: guildConfig.staffRoleId, deny: ['VIEW_CHANNEL'] },
      { id: ticket.userId, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'] },
      { id: interaction.user.id, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'] }
    ]);

    await interaction.reply({ content: `Ticket claimed by ${interaction.user}.`, ephemeral: true });
  }

  // ---------- Call Management ----------
  else if (interaction.customId === 'request_help_void_ticket') {
    const ticket = activeTickets.get(interaction.channel.id) || Object.values(activeTickets).find(t => t.channelId === interaction.channel.id);
    if (!ticket) return;

    const row = new MessageActionRow()
      .addComponents(
        new MessageButton().setCustomId('management_Chief of Operations').setLabel('Chief of Operations').setStyle('PRIMARY'),
        new MessageButton().setCustomId('management_Co-Owner').setLabel('Co-Owner').setStyle('PRIMARY'),
        new MessageButton().setCustomId('management_Owner').setLabel('Owner').setStyle('PRIMARY')
      );

    const embed = new MessageEmbed()
      .setTitle('Call Management System')
      .setDescription('Select which management staff to call.')
      .setColor('#0066CC')
      .setAuthor({ name: 'Void Tickets', iconURL: client.user.displayAvatarURL() || undefined });

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  }

  // ---------- Get Transcript ----------
  else if (interaction.customId === 'get_void_transcript') {
    const ticket = activeTickets.get(interaction.channel.id) || Object.values(activeTickets).find(t => t.channelId === interaction.channel.id);
    if (!ticket) return;

    await interaction.deferReply({ ephemeral: true });
    const transcriptPath = await generateHtmlTranscript(interaction.channel);
    await interaction.followUp({ content: 'Here is the current transcript.', files: [transcriptPath], ephemeral: true });
    fs.unlinkSync(transcriptPath);
  }

  // ---------- Management Buttons ----------
  else if (interaction.customId.startsWith('management_')) {
    const ticket = activeTickets.get(interaction.channel.id) || Object.values(activeTickets).find(t => t.channelId === interaction.channel.id);
    if (!ticket) return;

    const roleName = interaction.customId.split('_')[1];
    const roleId = guildConfig.highStaffRoles?.[roleName];
    if (roleId) {
      const role = await interaction.guild.roles.fetch(roleId).catch(err => {
        console.error(`Failed to fetch role ${roleId} in guild ${guildId}:`, err);
        return null;
      });
      if (role) {
        await interaction.channel.send(`${role} has been called for assistance.`);
        await interaction.update({ content: `Requested ${roleName} assistance.`, components: [] });
      } else {
        await interaction.update({ content: `Role ${roleName} not found.`, components: [] });
      }
    } else {
      await interaction.update({ content: `No role ID configured for ${roleName}.`, components: [] });
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
        if ((now - ticket.lastActivity) / 1000 > INACTIVITY_TIMEOUT) {
          const channel = await client.channels.fetch(ticket.channelId).catch(() => null);
          if (!channel) continue;

          const transcriptPath = await generateHtmlTranscript(channel);
          const embed = new MessageEmbed()
            .setTitle('Ticket Auto-Closed')
            .setDescription('This ticket has been closed due to inactivity (6 hours). Transcript attached.')
            .setColor('#FFA500')
            .setAuthor({ name: 'Void Tickets', iconURL: client.user.displayAvatarURL() || undefined });

          await channel.send({ embeds: [embed], files: [transcriptPath] });
          fs.unlinkSync(transcriptPath);

          if (config[ticket.guildId].logChannelId) {
            const logChannel = await client.channels.fetch(config[ticket.guildId].logChannelId).catch(() => null);
            if (logChannel) await logChannel.send(`Ticket auto-closed: <#${channel.id}> (user: <@${ticket.userId}>) due to inactivity`);
          }

          activeTickets.delete(userId);
          await setTimeout(10000);
          await channel.delete().catch(() => console.log(`Cannot delete channel ${channel.id}`));
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
  fs.writeFileSync(transcriptPath, htmlContent);
  return transcriptPath;
}

// ---------- Login ----------
const firstGuildId = Object.keys(config)[0];
if (firstGuildId && config[firstGuildId].botToken) {
  client.login(config[firstGuildId].botToken).catch(err => {
    console.error('Failed to login with bot token:', err);
    process.exit(1);
  });
} else {
  console.error('No valid bot token found in config. Please run "node setup-guild.js" first.');
  process.exit(1);
}
