const fs = require('fs');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const CONFIG_FILE = 'config.json';

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
  return {};
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

console.log('Void Tickets Setup - Run with node setup-guild.js (appends for multi-server)');
rl.question('Enter Bot Token (shared across servers): ', (botToken) => {
  rl.question('Enter Guild ID: ', (guildId) => {
    rl.question('Enter Staff Role ID: ', (staffRoleId) => {
      rl.question('Enter Ticket Channel Name Prefix (e.g., ticket-): ', (channelPrefix) => {
        rl.question('Enter Category ID for Tickets (optional): ', (categoryId) => {
          rl.question('Enter Panel Channel ID (bot auto-sends panel here): ', (panelChannelId) => {
            rl.question('Enter Log Channel ID (optional, press Enter to skip): ', (logChannelId) => {
              rl.question('Enter Chief of Operations Role ID (optional): ', (chiefOpsId) => {
                rl.question('Enter Co-Owner Role ID (optional): ', (coOwnerId) => {
                  rl.question('Enter Owner Role ID (optional): ', (ownerId) => {
                    rl.question('Enter Log Server ID (optional, for transcript logging): ', (logServerId) => {
                      const config = loadConfig();
                      if (!config[guildId]) {
                        config[guildId] = {};
                      }
                      config[guildId].botToken = botToken; // Shared token
                      config[guildId].staffRoleId = parseInt(staffRoleId);
                      config[guildId].channelPrefix = channelPrefix || 'ticket-';
                      config[guildId].categoryId = categoryId ? parseInt(categoryId) : null;
                      config[guildId].panelChannelId = parseInt(panelChannelId);
                      config[guildId].logChannelId = logChannelId ? parseInt(logChannelId) : null;
                      config[guildId].highStaffRoles = {
                        'Chief of Operations': chiefOpsId ? parseInt(chiefOpsId) : null,
                        'Co-Owner': coOwnerId ? parseInt(coOwnerId) : null,
                        'Owner': ownerId ? parseInt(ownerId) : null
                      };
                      config[guildId].logServerId = logServerId ? parseInt(logServerId) : null;
                      saveConfig(config);
                      console.log(`Setup complete for Guild ID ${guildId}! Configuration appended. Run again for another server.`);
                      rl.close();
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});
