// Starts the app and leaves it up for an interactive look over CDP (`agent-browser connect <port>`): against fake
// launchers with --fake, or read-only against whatever this PC has. The HOLD lines name the port and the stop file;
// the run ends when that file exists, when the app is quit from the page, or after 30 minutes (--hold=<minutes>
// changes that). Any other scenario takes --hold to stay up at its end state instead.
export const name = 'hold';
export const options = { hold: true };

export default async (d) => {
  await d.shot('start');
};
