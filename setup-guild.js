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

console.log('Void Tickets Setup');
rl.question('Enter Guild ID: ', (guildId) => {
  rl.question('Enter Staff Role ID: ', (staffRoleId) => {
    rl.question('Enter Log Channel ID (optional, press Enter to skip): ', (logChannelId) => {
      rl.question('Enter Chief of Operations Role ID (optional): ', (chiefOpsId) => {
        rl.question('Enter Co-Owner Role ID (optional): ', (coOwnerId) => {
          rl.question('Enter Owner Role ID (optional): ', (ownerId) => {
            rl.question('Enter Log Server ID (optional, for transcript logging): ', (logServerId) => {
              const config = loadConfig();
              config[guildId] = {
                staffRoleId: parseInt(staffRoleId),
                logChannelId: logChannelId ? parseInt(logChannelId) : null,
                highStaffRoles: {
                  'Chief of Operations': chiefOpsId ? parseInt(chiefOpsId) : null,
                  'Co-Owner': coOwnerId ? parseInt(coOwnerId) : null,
                  'Owner': ownerId ? parseInt(ownerId) : null
                },
                logServerId: logServerId ? parseInt(logServerId) : null
              };
              saveConfig(config);
              console.log(`Setup complete for Guild ID ${guildId}!`);
              rl.close();
            });
          });
        });
      });
    });
  });
});
