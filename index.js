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
  if (fs.existsSync(CONFIG_FILE)) {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
  console.error('No configuration found. Please run "node setup-guild.js" first.');
  process.exit(1);
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

const activeTickets = new Map();
const INACTIVITY_TIMEOUT = 21600; // 6 hours in seconds

// ---------- Auto Panel Creation / Management ----------
async function sendOrUpdatePanel(guildId) {
  const guildConfig = config[guildId];
  if (!guildConfig || !guildConfig.panelChannelId) return;

  try {
    const guild = await client.guilds.fetch(guildId);
    const panelChannel = await guild.channels.fetch(guildConfig.panelChannelId);
    if (!panelChannel) return;

    // Check if panel exists and still valid
    let panelMessage;
    if (guildConfig.panelMessageId) {
      try {
        panelMessage = await panelChannel.messages.fetch(guildConfig.panelMessageId);
      } catch {
        panelMessage = null;
      }
    }

    const embed = new MessageEmbed()
      .setTitle('Void Tickets')
      .setDescription('Click the button below to open a new ticket.')
      .setColor('#0066CC')
      .setAuthor({ name: 'Void Tickets', iconURL: 'https://i.imgur.com/placeholder_icon.png' });

    const row = new MessageActionRow()
      .addComponents(
        new MessageButton()
          .setCustomId('open_void_ticket')
          .setLabel('Open Ticket')
          .setStyle('PRIMARY')
      );

    if (!panelMessage) {
      const message = await panelChannel.send({ embeds: [embed], components: [row] });
      guildConfig.panelMessageId = message.id;
      saveConfig();
      console.log(`Panel created in guild ${guildId} in channel ${panelChannel.id}`);
    } else {
      await panelMessage.edit({ embeds: [embed], components: [row] });
      console.log(`Panel updated in guild ${guildId}`);
    }
  } catch (err) {
    console.error(`Failed to send/update panel for guild ${guildId}:`, err);
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

  const guildId = interaction.guild.id.toString();
  const guildConfig = config[guildId];
  if (!guildConfig) return;

  const userId = interaction.user.id;

  // ---------- Open Ticket ----------
  if (interaction.customId === 'open_void_ticket') {
    if (activeTickets.has(userId)) {
      await interaction.reply({ content: 'You already have an open ticket!', ephemeral: true });
      return;
    }

    // Determine category
    let category = guildConfig.categoryId
      ? interaction.guild.channels.cache.get(guildConfig.categoryId)
      : interaction.guild.channels.cache.find(c => c.name === 'Void Tickets' && c.type === 'GUILD_CATEGORY');

    if (!category) {
      category = await interaction.guild.channels.create('Void Tickets', { type: 'GUILD_CATEGORY', permissionOverwrites: [{ id: interaction.guild.id, deny: ['VIEW_CHANNEL'] }] });
    }

    const channelName = `${guildConfig.channelPrefix || 'ticket-'}${interaction.user.username}-${userId % 10000}`;
    const channel = await interaction.guild.channels.create(channelName, {
      type: 'GUILD_TEXT',
      parent: category,
      permissionOverwrites: [
        { id: interaction.guild.id, deny: ['VIEW_CHANNEL'] },
        { id: userId, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'] },
        { id: client.user.id, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'] },
        { id: guildConfig.staffRoleId, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'] }
      ]
    });

    activeTickets.set(userId, { channelId: channel.id, guildId, userId, lastActivity: Date.now(), claimedBy: null });

    const embed = new MessageEmbed()
      .setTitle(`Void Tickets - Support Ticket`)
      .setDescription('Our staff will be with you shortly, please state your issue.')
      .setColor('#0066CC')
      .setAuthor({ name: 'Void Tickets', iconURL: 'https://i.imgur.com/placeholder_icon.png' });

    const row = new MessageActionRow()
      .addComponents(
        new MessageButton().setCustomId('close_void_ticket').setLabel('Close').setStyle('DANGER'),
        new MessageButton().setCustomId('claim_void_ticket').setLabel('Claim').setStyle('PRIMARY'),
        new MessageButton().setCustomId('request_help_void_ticket').setLabel('Call Management').setStyle('SECONDARY'),
        new MessageButton().setCustomId('get_void_transcript').setLabel('Transcript').setStyle('SECONDARY')
      );

    await channel.send({ content: `<@${userId}> <@&${guildConfig.staffRoleId}>`, embeds: [embed], components: [row] });

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
    if (!interaction.member.roles.cache.has(guildConfig.staffRoleId)) return interaction.reply({ content: 'Only staff can close tickets.', ephemeral: true });

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
    if (!interaction.member.roles.cache.has(guildConfig.staffRoleId)) return interaction.reply({ content: 'Only staff can claim tickets.', ephemeral: true });

    ticket.claimedBy = interaction.user.id;
    const newChannelName = `${guildConfig.channelPrefix || 'ticket-'}claimed-${interaction.user.username}-${ticket.userId % 10000}`;
    await interaction.channel.setName(newChannelName);

    const everyoneRole = interaction.guild.roles.everyone;
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
      .setAuthor({ name: 'Void Tickets', iconURL: 'https://i.imgur.com/placeholder_icon.png' });

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
    const roleId = guildConfig.highStaffRoles[roleName];
    if (roleId) {
      const role = interaction.guild.roles.cache.get(roleId);
      if (role) {
        await interaction.channel.send(`${role} has been called for assistance.`);
        await interaction.update({ content: `Requested ${roleName} assistance.`, components: [] });
      } else {
        await interaction.update({ content: `Role ${roleName} not found.`, components: [] });
      }
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
            .setAuthor({ name: 'Void Tickets', iconURL: 'https://i.imgur.com/placeholder_icon.png' });

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
  client.login(config[firstGuildId].botToken);
} else {
  console.error('No valid bot token found in config. Please run "node setup-guild.js" first.');
  process.exit(1);
}
