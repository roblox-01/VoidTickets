const { Client, GatewayIntentBits, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, PermissionsBitField } = require('discord.js');
const fs = require('fs');
const { setTimeout } = require('timers/promises');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const CONFIG_FILE = 'config.json';
let config = loadConfig();

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
  console.error('No configuration found. Please run "npm run setup" first.');
  process.exit(1);
}

const activeTickets = new Map();

const INACTIVITY_TIMEOUT = 21600; // 6 hours in seconds

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  autocloseTickets.start();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  const guildId = interaction.guild.id;
  if (!config[guildId]) return;

  if (interaction.customId === 'open_void_ticket') {
    if (activeTickets.has(interaction.user.id)) {
      await interaction.reply({ content: 'You already have an open ticket! Close it first.', ephemeral: true });
      return;
    }

    const category = interaction.guild.channels.cache.find(c => c.name === 'Void Tickets' && c.type === 4) ||
      await interaction.guild.channels.create({
        name: 'Void Tickets',
        type: 4,
        permissionOverwrites: [
          { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] }
        ]
      });

    const channel = await interaction.guild.channels.create({
      name: `void-ticket-${interaction.user.username}-${interaction.user.id % 10000}`,
      type: 0,
      parent: category,
      permissionOverwrites: [
        { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
        { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
        { id: config[guildId].staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
      ]
    });

    activeTickets.set(interaction.user.id, {
      channelId: channel.id,
      guildId,
      userId: interaction.user.id,
      lastActivity: Date.now(),
      claimedBy: null
    });

    const embed = new EmbedBuilder()
      .setTitle('Void Tickets - General Support Ticket')
      .setDescription('Our staff will be with you shortly, please state your issue.')
      .setColor(0x0066CC)
      .setAuthor({ name: 'Void Tickets', iconURL: 'https://i.imgur.com/placeholder_icon.png' }); // Replace with your icon URL
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder().setCustomId('close_void_ticket').setLabel('Close').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('claim_void_ticket').setLabel('Claim').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('request_help_void_ticket').setLabel('Call Management').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('get_void_transcript').setLabel('Transcript').setStyle(ButtonStyle.Secondary)
      );
    await channel.send({ content: `${interaction.user} <@&${config[guildId].staffRoleId}>`, embeds: [embed], components: [row] });

    const logChannelId = config[guildId].logChannelId;
    if (logChannelId) {
      const logChannel = await client.channels.fetch(logChannelId);
      if (logChannel) await logChannel.send(`Ticket created: <#${channel.id}> by ${interaction.user}`);
    }

    await interaction.reply({ content: `Your ticket has been created: <#${channel.id}>`, ephemeral: true });
  } else if (interaction.customId === 'close_void_ticket') {
    const ticket = activeTickets.get(interaction.channel.id);
    if (!ticket || !interaction.member.roles.cache.has(config[ticket.guildId].staffRoleId)) {
      await interaction.reply({ content: 'Only staff can close tickets.', ephemeral: true });
      return;
    }

    await interaction.deferReply();
    const transcriptPath = await generateHtmlTranscript(interaction.channel);
    await interaction.followUp({ content: 'Ticket closing in 10 seconds... Transcript attached.', files: [transcriptPath] });
    fs.unlinkSync(transcriptPath);

    const logChannelId = config[ticket.guildId].logChannelId;
    if (logChannelId) {
      const logChannel = await client.channels.fetch(logChannelId);
      if (logChannel) await logChannel.send(`Ticket closed: <#${interaction.channel.id}> by ${interaction.user} (user: <@${ticket.userId}>)`);
    }

    activeTickets.delete(interaction.channel.id);
    await setTimeout(10000);
    await interaction.channel.delete();
  } else if (interaction.customId === 'claim_void_ticket') {
    const ticket = activeTickets.get(interaction.channel.id);
    if (!ticket || !interaction.member.roles.cache.has(config[ticket.guildId].staffRoleId)) {
      await interaction.reply({ content: 'Only staff can claim tickets.', ephemeral: true });
      return;
    }

    ticket.claimedBy = interaction.user.id;
    const everyoneRole = interaction.guild.roles.everyone;
    const highStaffRoles = config[ticket.guildId].highStaffRoles;
    await interaction.channel.permissionOverwrites.edit(everyoneRole, { ViewChannel: false });
    await interaction.channel.permissionOverwrites.edit(config[ticket.guildId].staffRoleId, { ViewChannel: false });
    for (const roleId of Object.values(highStaffRoles).filter(id => id)) {
      await interaction.channel.permissionOverwrites.edit(roleId, { ViewChannel: false });
    }
    await interaction.channel.permissionOverwrites.edit(interaction.user.id, { ViewChannel: true, SendMessages: true });
    await interaction.channel.permissionOverwrites.edit(ticket.userId, { ViewChannel: true, SendMessages: true });
    await interaction.reply({ content: `Ticket claimed by ${interaction.user}. Only you and the ticket creator can see this now.`, ephemeral: true });
  } else if (interaction.customId === 'request_help_void_ticket') {
    const ticket = activeTickets.get(interaction.channel.id);
    if (!ticket) {
      await interaction.reply({ content: 'This isn\'t a Void Ticket channel.', ephemeral: true });
      return;
    }

    const view = new ManagementSelectionView(interaction.channel.id);
    const embed = new EmbedBuilder()
      .setTitle('Call Management System')
      .setDescription('Please pick which management staff you would like to call?')
      .setColor(0x0066CC)
      .setAuthor({ name: 'Void Tickets', iconURL: 'https://i.imgur.com/placeholder_icon.png' });
    await interaction.reply({ embeds: [embed], components: [view], ephemeral: true });
  } else if (interaction.customId === 'get_void_transcript') {
    const ticket = activeTickets.get(interaction.channel.id);
    if (!ticket) {
      await interaction.reply({ content: 'This isn\'t a Void Ticket channel.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const transcriptPath = await generateHtmlTranscript(interaction.channel);
    await interaction.followUp({ content: 'Here is the current transcript.', files: [transcriptPath], ephemeral: true });
    fs.unlinkSync(transcriptPath);
  } else if (interaction.customId.startsWith('management_')) {
    const ticket = activeTickets.get(interaction.channel.id);
    if (!ticket) return;

    const roleName = interaction.customId.split('_')[1];
    const roleId = config[ticket.guildId].highStaffRoles[roleName];
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

class ManagementSelectionView extends ActionRowBuilder {
  constructor(channelId) {
    super();
    this.addComponents(
      new ButtonBuilder().setCustomId('management_Chief of Operations').setLabel('Chief of Operations').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('management_Co-Owner').setLabel('Co-Owner').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('management_Owner').setLabel('Owner').setStyle(ButtonStyle.Primary)
    );
  }
}

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
    htmlContent += `
      <div class="message">
        <span class="user">${author}</span> <span class="timestamp">[${timestamp}]</span>
        <div class="content">${content}</div>
        ${attachments}
      </div>
    `;
  });

  htmlContent += '</body></html>';

  fs.writeFileSync(transcriptPath, htmlContent);
  return transcriptPath;
}

const autocloseTickets = {
  interval: null,
  start() {
    this.interval = setInterval(async () => {
      const now = Date.now();
      for (const [userId, ticket] of activeTickets) {
        if ((now - ticket.lastActivity) / 1000 > INACTIVITY_TIMEOUT) {
          const channel = await client.channels.fetch(ticket.channelId);
          if (channel) {
            const transcriptPath = await generateHtmlTranscript(channel);
            const embed = new EmbedBuilder()
              .setTitle('Ticket Auto-Closed')
              .setDescription('This ticket has been closed due to inactivity (6 hours). Transcript attached.')
              .setColor(0xFFA500)
              .setAuthor({ name: 'Void Tickets', iconURL: 'https://i.imgur.com/placeholder_icon.png' });
            await channel.send({ embeds: [embed], files: [transcriptPath] });
            fs.unlinkSync(transcriptPath);

            const logGuildId = config[ticket.guildId].logServerId;
            if (logGuildId && client.guilds.cache.has(logGuildId)) {
              const logChannelId = config[ticket.guildId].logChannelId;
              if (logChannelId) {
                const logChannel = await client.channels.fetch(logChannelId);
                if (logChannel) await logChannel.send(`Ticket auto-closed: <#${channel.id}> (user: <@${ticket.userId}>) due to inactivity`);
              }
            } else {
              const logChannelId = config[ticket.guildId].logChannelId;
              if (logChannelId) {
                const logChannel = await client.channels.fetch(logChannelId);
                if (logChannel) await logChannel.send(`Ticket auto-closed: <#${channel.id}> (user: <@${ticket.userId}>) due to inactivity`);
              }
            }

            activeTickets.delete(userId);
            await setTimeout(10000);
            await channel.delete().catch(() => console.log(`Cannot delete channel ${channel.id} due to missing permissions`));
          }
        }
      }
    }, 60000); // Check every minute
  },
  stop() {
    clearInterval(this.interval);
  }
};

client.on('messageCreate', message => {
  if (activeTickets.has(message.channel.id) && !message.author.bot) {
    activeTickets.get(message.channel.id).lastActivity = Date.now();
  }
});

const guildId = Object.keys(config)[0]; // Use the first configured guild
if (guildId && config[guildId].botToken) {
  client.login(config[guildId].botToken);
} else {
  console.error('No valid bot token found in config. Please run "npm run setup" first.');
  process.exit(1);
}
