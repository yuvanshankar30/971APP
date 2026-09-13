package Display;

import SheetHandler.Part;
import SheetHandler.Sheet;

public class EditAction {
    private enum Type {
        MOVE_PART,
        ADD_PART,
        REMOVE_PART
    }

    private double xFrom;
    private double yFrom;
    private double rotFrom;
    private double xTo;
    private double yTo;
    private double rotTo;
    private Part part;
    private Type type;

    public EditAction(Part part, double _xFrom, double _yFrom, double _rotFrom, double _xTo, double _yTo,
            double _rotTo) {
        xFrom = _xFrom;
        yFrom = _yFrom;
        rotFrom = _rotFrom;
        xTo = _xTo;
        yTo = _yTo;
        rotTo = _rotTo;
        this.part = part;
        type = Type.MOVE_PART;
    }

    public EditAction(Part part, double _xFrom, double _yFrom, double _rotFrom) {
        this(part, _xFrom, _yFrom, _rotFrom, part.getX(), part.getY(), part.getRot());
    }

    /**
     * Creates an add/remove operation
     * 
     * @param part   - the part being affected
     * @param adding - true if adding a part, false if removing it
     */
    public EditAction(Part part, boolean adding) {
        this.part = part;
        type = adding ? Type.ADD_PART : Type.REMOVE_PART;
    }

    public void undoAction(Sheet sheet) {
        switch (type) {
            case MOVE_PART -> {
                part.setX(xFrom);
                part.setY(yFrom);
                part.setRot(rotFrom);
            }

            case ADD_PART -> {
                sheet.removePart(part);
            }

            case REMOVE_PART -> {
                sheet.addPart(part);
            }
        }
    }

    public void redoAction(Sheet sheet) {
        switch (type) {
            case MOVE_PART -> {
                part.setX(xTo);
                part.setY(yTo);
                part.setRot(rotTo);
            }

            case ADD_PART -> {
                sheet.addPart(part);
            }

            case REMOVE_PART -> {
                sheet.removePart(part);
            }
        }
    }

    public boolean doesSomething() {
        if (type != Type.MOVE_PART) {
            return true;
        }
        if (xTo == xFrom && yTo == yFrom && rotTo == rotFrom) {
            return false;
        } else {
            return true;
        }
    }
}
