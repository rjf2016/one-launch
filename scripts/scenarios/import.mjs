// Import accounts from what the launchers remember: Steam's loginusers.vdf (four users, two already in One Launch)
// and Battle.net's saved account names (five, two already in). Only names and ids come in; no password.
// The Import menu names every launcher: Epic Games and Riot Games keep no list, and their entries open the account form.
export const name = 'import';
export const options = { fake: 'all-four' };

export default async (d) => {
  await d.waitFor('Rocket League');
  const before = (await d.invoke('accounts:list')).accounts.length;

  await d.click('Accounts');
  await d.waitFor('Persona One');
  await d.click('Import');
  await d.click({ contains: 'From Steam' });
  await d.waitFor('Persona Four');
  const steamText = await d.text();
  d.check(
    'Steam: the four remembered users are listed',
    ['Persona One', 'Persona Two', 'Persona Three', 'Persona Four'].every((n) => steamText.includes(n)),
  );
  d.check('Steam: the two known accounts are marked', steamText.split('Already in One Launch').length - 1 === 2);
  d.check('Steam: the signed-in one is marked', steamText.includes('Signed in'));
  d.check('Steam: two are preselected', steamText.includes('2 selected'));
  await d.shot('import-steam');
  await d.click('Import 2');
  await d.waitFor('Imported 2 accounts from Steam');
  await d.shot('imported-steam');

  await d.click('Import');
  await d.click({ contains: 'From Battle.net' });
  await d.waitFor('saved5@example.com');
  const bnetText = await d.text();
  d.check(
    'Battle.net: the five saved logins are listed',
    [1, 2, 3, 4, 5].every((n) => bnetText.includes(`saved${n}@example.com`)),
  );
  d.check('Battle.net: the two known accounts are marked', bnetText.split('Already in One Launch').length - 1 === 2);
  d.check('Battle.net: three are preselected', bnetText.includes('3 selected'));
  await d.shot('import-battlenet');
  await d.click('Import 3');
  await d.waitFor('Imported 3 accounts from Battle.net');
  await d.shot('imported-battlenet');

  const { accounts } = await d.invoke('accounts:list');
  d.check('five accounts were added', accounts.length === before + 5, `${before} -> ${accounts.length}`);
  const two = accounts.find((a) => a.launcher === 'steam' && a.login === 'user_2');
  d.check(
    'the Steam import carries the persona name and the SteamID',
    two?.displayName === 'Persona Two' && two.launcherUid === '76561198000000002',
    JSON.stringify(two),
  );
  const five = accounts.find((a) => a.launcher === 'battlenet' && a.login === 'saved5@example.com');
  d.check('the Battle.net import carries the login and no id yet', Boolean(five) && five.launcherUid === null, JSON.stringify(five));
  d.check(
    'no imported account has a password',
    accounts.filter((a) => !['Persona Three', 'New', 'Riot New'].includes(a.displayName)).every((a) => a.hasSecret === false),
  );

  await d.click('Import');
  await d.click({ contains: 'From Steam' });
  await d.waitFor('Everything here is already in One Launch.');
  await d.shot('import-steam-nothing-left');
  await d.click('Cancel');

  await d.click('Import');
  await d.waitFor('Riot Games: add by hand');
  const menuText = await d.text();
  d.check(
    'the Import menu names every launcher, with Epic and Riot pointing at Add by hand',
    ['From Steam', 'From Battle.net', 'Epic Games: add by hand', 'Riot Games: add by hand'].every((t) => menuText.includes(t)),
  );
  await d.shot('import-menu');
  await d.click({ contains: 'Riot Games: add by hand' });
  await d.waitFor('New Riot Games account');
  await d.shot('riot-by-hand');
};
