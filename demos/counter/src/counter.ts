import * as collabs from "@collabs/collabs";
import { CRDTContainer } from "@collabs/container";

(async function () {
  // Create a CRDTContainer - like CRDTApp, but intended for
  // use within containers.
  const container = new CRDTContainer(window.parent, {});

  // Now setup your program, using container.

  // We include a simple collaborative counter as an example;
  // delete the code below and replace with your own.
  // Remember to do `await container.load()` at some point
  // and then display the resulting state.

  // Register collaborative data types.
  const counterCollab = container.registerCollab(
    "counter",
    collabs.Pre(collabs.CCounter)()
  );

  // Wait for the container to load the previous saved state,
  // if any.
  // Note that unlike CRDTApp.load, we don't need to provide the
  // save data ourselves.
  await container.load();
  container.receiveFurtherMessages();

  // Display the loaded state.
  const display = document.getElementById("display")!;
  function refreshDisplay() {
    display.innerHTML = counterCollab.value.toString();
  }
  refreshDisplay();

  // Refresh the display when the Collab state changes, possibly
  // due to a message from another replica.
  container.on("Change", refreshDisplay);

  // Change counterCollab's value on button clicks.
  // Note that we don't need to refresh the display here, since Change
  // events are also triggered by local operations.
  document.getElementById("increment")!.onclick = () => {
    counterCollab.add(100);
  };
  document.getElementById("decrement")!.onclick = () => {
    counterCollab.add(-100);
  };
  document.getElementById("reset")!.onclick = () => {
    counterCollab.reset();
  };
})();
