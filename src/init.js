const init = {
  injectCustomStyles: () => {
    const styleEl = document.createElement('style');
    styleEl.textContent = styles.tippy.theme;
    document.head.append(styleEl);

    const customStyles = document.createElement('style');
    const marginClasses = [];

    for (let i = 1; i <= 15; i++) {
      marginClasses.push(`.m-l-${i} {margin-left: ${i}px;}`);
      marginClasses.push(`.m-t-${i} {margin-top: ${i}px;}`);
    }

    customStyles.textContent = marginClasses.join('\n');
    document.head.append(customStyles);
  },
};
// Posts with active downloads.
let processing = [];
