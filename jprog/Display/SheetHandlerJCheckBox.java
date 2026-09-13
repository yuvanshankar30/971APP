package Display;

import javax.swing.JCheckBox;

/**
 * Abstract class that allows JCheckBox to hold an object of class {@code T}
 */
public class SheetHandlerJCheckBox<T> extends JCheckBox {
    private T genericThing;

    public SheetHandlerJCheckBox(String text, T genericThing) {
        super(text);
        setgenericThing(genericThing);
    }

    public void setgenericThing(T genericThing) {
        this.genericThing = genericThing;
    }

    public T getgenericThing() {
        return genericThing;
    }
}
