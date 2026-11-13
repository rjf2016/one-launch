const REASON = 'drawn by Windows or by the stock installer, not by the app; the owner decided it is not compared';

export const WAIVED = [169, 170, 171, 172, 173, 174].map((row) => ({ row, waivedBy: 'owner', category: 'windows-drawn', reason: REASON }));

export const NOT_PRODUCED = [
  {
    file: 'takeover/installed-registry.json',
    reason:
      'the owner runs no installer for it; the registry values the installer writes are read on a GitHub-hosted runner after installing the public release (takeover/contract.md, O7 and the checks tagged runner-reg)',
  },
];
